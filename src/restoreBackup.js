import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptBackup } from "./backupCrypto.js";
import { createRepository } from "./storage.js";

const REQUIRED_TABLES = ["change_events", "rate_versions", "sites"];

export async function restoreEncryptedBackup({
  backupPath,
  password,
  paths,
  credentialStore,
  assertServiceStopped,
  clock = () => new Date(),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  copyFileImpl = copyFile,
  renameImpl = rename,
  rmImpl = rm,
  accessImpl = access,
  DatabaseSyncImpl = DatabaseSync,
  createRepositoryImpl = createRepository,
  randomUUIDImpl = randomUUID
}) {
  await assertServiceStopped();

  if (!backupPath || !paths?.dataDir || !paths?.dbPath || !paths?.credentialVaultPath
      || typeof credentialStore?.replaceAll !== "function") {
    throw restoreError("恢复参数无效", "RESTORE_ARGUMENT_INVALID");
  }

  const serialized = await readFileImpl(backupPath, "utf8");
  const payload = await decryptBackup(serialized, password);
  validatePayload(payload);

  const databaseBytes = decodeCanonicalBase64(payload.database.content);
  const actualChecksum = createHash("sha256").update(databaseBytes).digest("hex");
  if (actualChecksum !== payload.database.sha256) {
    throw restoreError("备份数据库校验失败", "BACKUP_CHECKSUM_INVALID");
  }

  await mkdirImpl(paths.dataDir, { recursive: true });
  const candidatePath = path.join(paths.dataDir, `.prices.restore-${randomUUIDImpl()}.db`);
  let candidateCreated = false;
  let replacementStarted = false;
  let operationError;
  let snapshots;

  try {
    await writeFileImpl(candidatePath, databaseBytes, { flag: "wx", mode: 0o600 });
    candidateCreated = true;
    validateDatabase(candidatePath, DatabaseSyncImpl);

    const stamp = restoreStamp(clock());
    snapshots = await createSnapshots({
      paths,
      stamp,
      accessImpl,
      copyFileImpl
    });

    replacementStarted = true;
    await removeTargets(paths, rmImpl);
    await renameImpl(candidatePath, paths.dbPath);
    candidateCreated = false;
    await credentialStore.replaceAll(payload.credentials);

    let repository;
    try {
      repository = createRepositoryImpl({ dbPath: paths.dbPath });
      repository.migrate();
      const siteCount = repository.listSites().total;
      return {
        siteCount,
        databaseBackupPath: snapshots.database.exists ? snapshots.database.backupPath : null,
        credentialBackupPath: snapshots.credentials.exists ? snapshots.credentials.backupPath : null
      };
    } finally {
      repository?.close();
    }
  } catch (error) {
    operationError = error;
    if (replacementStarted) {
      const rollbackErrors = await rollbackTargets({ paths, snapshots, rmImpl, copyFileImpl });
      if (rollbackErrors.length > 0) {
        attachDiagnostic(error, "rollbackErrors", rollbackErrors.map(({ targetPath, error: rollbackError }) => ({
          targetPath,
          code: rollbackError?.code,
          message: rollbackError?.message ?? String(rollbackError)
        })));
      }
    }
    throw error;
  } finally {
    if (candidateCreated) {
      try {
        await rmImpl(candidatePath, { force: true });
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
        attachDiagnostic(operationError, "candidateCleanupError", {
          code: cleanupError?.code,
          message: cleanupError?.message ?? String(cleanupError)
        });
      }
    }
  }
}

function validatePayload(payload) {
  const validDatabase = payload?.database
    && typeof payload.database === "object"
    && !Array.isArray(payload.database)
    && payload.database.encoding === "base64"
    && /^[0-9a-f]{64}$/.test(payload.database.sha256)
    && isCanonicalBase64(payload.database.content);

  if (payload?.payloadVersion !== 1 || !validDatabase || !validCredentials(payload?.credentials)) {
    throw restoreError("备份载荷结构无效", "BACKUP_PAYLOAD_INVALID");
  }
}

function validCredentials(entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
  return Object.entries(entries).every(([reference, credentials]) => (
    /^site:\d+$/.test(reference)
      && credentials
      && typeof credentials === "object"
      && !Array.isArray(credentials)
      && Object.keys(credentials).length > 0
      && Object.values(credentials).every((value) => typeof value === "string")
  ));
}

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeCanonicalBase64(value) {
  if (!isCanonicalBase64(value)) {
    throw restoreError("备份数据库编码无效", "BACKUP_PAYLOAD_INVALID");
  }
  return Buffer.from(value, "base64");
}

function validateDatabase(candidatePath, DatabaseSyncImpl) {
  let database;
  try {
    database = new DatabaseSyncImpl(candidatePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error("integrity_check failed");
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sites', 'rate_versions', 'change_events')"
    ).all().map((row) => row.name));
    if (!REQUIRED_TABLES.every((table) => tables.has(table))) throw new Error("required tables missing");
  } catch (error) {
    if (error?.code === "BACKUP_DATABASE_INVALID") throw error;
    throw restoreError("备份数据库无效", "BACKUP_DATABASE_INVALID", error);
  } finally {
    database?.close();
  }
}

async function createSnapshots({ paths, stamp, accessImpl, copyFileImpl }) {
  const targets = [
    ["database", paths.dbPath],
    ["credentials", paths.credentialVaultPath],
    ["wal", `${paths.dbPath}-wal`],
    ["shm", `${paths.dbPath}-shm`]
  ];
  const snapshots = {};
  for (const [name, targetPath] of targets) {
    const backupPath = `${targetPath}.restore-${stamp}.bak`;
    const exists = await pathExists(targetPath, accessImpl);
    if (exists) await copyFileImpl(targetPath, backupPath, fsConstants.COPYFILE_EXCL);
    snapshots[name] = { targetPath, backupPath, exists };
  }
  return snapshots;
}

async function removeTargets(paths, rmImpl) {
  for (const targetPath of [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) {
    await rmImpl(targetPath, { force: true });
  }
}

async function rollbackTargets({ paths, snapshots, rmImpl, copyFileImpl }) {
  const rollbackErrors = [];
  const targets = [
    snapshots.database,
    snapshots.credentials,
    snapshots.wal,
    snapshots.shm
  ];

  for (const targetPath of [paths.dbPath, paths.credentialVaultPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) {
    try {
      await rmImpl(targetPath, { force: true });
    } catch (error) {
      rollbackErrors.push({ targetPath, error });
    }
  }
  for (const snapshot of targets) {
    if (!snapshot.exists) continue;
    try {
      await copyFileImpl(snapshot.backupPath, snapshot.targetPath);
    } catch (error) {
      rollbackErrors.push({ targetPath: snapshot.targetPath, error });
    }
  }
  return rollbackErrors;
}

async function pathExists(targetPath, accessImpl) {
  try {
    await accessImpl(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function restoreStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw restoreError("恢复时间无效", "RESTORE_ARGUMENT_INVALID");
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function restoreError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function attachDiagnostic(error, name, value) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  try {
    error[name] = value;
  } catch {
    // Preserve the original error even when a caller throws a frozen object.
  }
}
