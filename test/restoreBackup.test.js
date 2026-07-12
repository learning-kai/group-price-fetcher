import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptBackup } from "../src/backupCrypto.js";
import { createCredentialStore } from "../src/credentialStore.js";
import { createExportService } from "../src/exportService.js";
import { restoreEncryptedBackup } from "../src/restoreBackup.js";
import { createRepository } from "../src/storage.js";

const PASSWORD = "correct horse battery staple";

test("offline restore replaces database and re-encrypts credentials", async () => {
  const fixture = await createRestoreFixture();
  try {
    const result = await restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: PASSWORD,
      paths: fixture.destination.paths,
      credentialStore: fixture.destination.store,
      assertServiceStopped: async () => {},
      clock: () => new Date("2026-07-13T04:00:00.000Z")
    });

    const restored = createRepository({ dbPath: fixture.destination.paths.dbPath });
    assert.equal(restored.listSites().total, 1);
    assert.equal(restored.listSites().items[0].name, "源站点");
    assert.equal(restored.listLatestRates().items[0].effectiveRateMultiplier, 0.08);
    restored.close();
    assert.deepEqual(await fixture.destination.store.get("site:1"), {
      email: "source@example.com",
      password: "source-secret"
    });
    assert.equal(result.siteCount, 1);
    assert.match(result.databaseBackupPath, /prices\.db\.restore-20260713-040000\.bak$/);
    assert.match(result.credentialBackupPath, /credentials\.vault\.restore-20260713-040000\.bak$/);
    await access(result.databaseBackupPath);
    await access(result.credentialBackupPath);
  } finally {
    await fixture.cleanup();
  }
});

test("service guard and wrong password leave destination byte-identical", async () => {
  const fixture = await createRestoreFixture();
  try {
    const before = await destinationBytes(fixture.destination.paths);
    let backupRead = false;
    await assert.rejects(() => restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: PASSWORD,
      paths: fixture.destination.paths,
      credentialStore: fixture.destination.store,
      assertServiceStopped: async () => { throw Object.assign(new Error("服务仍在运行"), { code: "SERVICE_RUNNING" }); },
      readFileImpl: async (...args) => { backupRead = true; return readFile(...args); }
    }), (error) => error.code === "SERVICE_RUNNING");
    assert.equal(backupRead, false);
    assert.deepEqual(await destinationBytes(fixture.destination.paths), before);

    await assert.rejects(() => restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: "totally wrong password",
      paths: fixture.destination.paths,
      credentialStore: fixture.destination.store,
      assertServiceStopped: async () => {}
    }), /密码错误或备份已损坏/);
    assert.deepEqual(await destinationBytes(fixture.destination.paths), before);
  } finally {
    await fixture.cleanup();
  }
});

test("checksum mismatch and missing SQLite tables are rejected before replacement", async () => {
  const fixture = await createRestoreFixture();
  try {
    const before = await destinationBytes(fixture.destination.paths);
    const badChecksum = structuredClone(fixture.payload);
    badChecksum.database.sha256 = "0".repeat(64);
    await writeFile(fixture.backupPath, await encryptBackup(badChecksum, PASSWORD));
    await assert.rejects(() => restoreFixtureBackup(fixture), (error) => error.code === "BACKUP_CHECKSUM_INVALID");
    assert.deepEqual(await destinationBytes(fixture.destination.paths), before);

    const invalidDbPath = path.join(fixture.root, "invalid.db");
    const invalid = new DatabaseSync(invalidDbPath);
    invalid.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    invalid.close();
    const invalidBytes = await readFile(invalidDbPath);
    const missingTables = structuredClone(fixture.payload);
    missingTables.database.content = invalidBytes.toString("base64");
    missingTables.database.sha256 = sha256(invalidBytes);
    await writeFile(fixture.backupPath, await encryptBackup(missingTables, PASSWORD));
    await assert.rejects(() => restoreFixtureBackup(fixture), (error) => error.code === "BACKUP_DATABASE_INVALID");
    assert.deepEqual(await destinationBytes(fixture.destination.paths), before);
  } finally {
    await fixture.cleanup();
  }
});

test("credential replacement failure rolls database and vault back together", async () => {
  const fixture = await createRestoreFixture();
  try {
    const before = await destinationBytes(fixture.destination.paths);
    const failingStore = {
      async replaceAll() {
        await writeFile(fixture.destination.paths.credentialVaultPath, "corrupted-vault", "utf8");
        throw new Error("injected DPAPI failure");
      }
    };
    await assert.rejects(() => restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: PASSWORD,
      paths: fixture.destination.paths,
      credentialStore: failingStore,
      assertServiceStopped: async () => {},
      clock: () => new Date("2026-07-13T04:00:00.000Z")
    }), /injected DPAPI failure/);
    assert.deepEqual(await destinationBytes(fixture.destination.paths), before);
  } finally {
    await fixture.cleanup();
  }
});

test("rollback restores original SQLite sidecars byte-for-byte", async () => {
  const fixture = await createRestoreFixture();
  const walPath = `${fixture.destination.paths.dbPath}-wal`;
  const shmPath = `${fixture.destination.paths.dbPath}-shm`;
  try {
    const walBytes = Buffer.from("original-wal-bytes");
    const shmBytes = Buffer.from("original-shm-bytes");
    await writeFile(walPath, walBytes);
    await writeFile(shmPath, shmBytes);
    const failingStore = {
      async replaceAll() {
        await writeFile(fixture.destination.paths.credentialVaultPath, "corrupted-vault", "utf8");
        throw new Error("injected credential failure");
      }
    };

    await assert.rejects(() => restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: PASSWORD,
      paths: fixture.destination.paths,
      credentialStore: failingStore,
      assertServiceStopped: async () => {},
      clock: () => new Date("2026-07-13T04:00:00.000Z")
    }), /injected credential failure/);

    assert.deepEqual(await readFile(walPath), walBytes);
    assert.deepEqual(await readFile(shmPath), shmBytes);
  } finally {
    await fixture.cleanup();
  }
});

test("rollback removes database and vault that did not exist before restore", async () => {
  const fixture = await createRestoreFixture();
  try {
    await rm(fixture.destination.paths.dbPath, { force: true });
    await rm(fixture.destination.paths.credentialVaultPath, { force: true });
    const failingStore = {
      async replaceAll() {
        await writeFile(fixture.destination.paths.credentialVaultPath, "new-vault", "utf8");
        throw new Error("injected credential failure");
      }
    };

    await assert.rejects(() => restoreEncryptedBackup({
      backupPath: fixture.backupPath,
      password: PASSWORD,
      paths: fixture.destination.paths,
      credentialStore: failingStore,
      assertServiceStopped: async () => {},
      clock: () => new Date("2026-07-13T04:00:00.000Z")
    }), /injected credential failure/);

    await assert.rejects(() => access(fixture.destination.paths.dbPath), (error) => error.code === "ENOENT");
    await assert.rejects(() => access(fixture.destination.paths.credentialVaultPath), (error) => error.code === "ENOENT");
  } finally {
    await fixture.cleanup();
  }
});

async function createRestoreFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-price-restore-"));
  const source = await createApp(path.join(root, "source"), "源站点", "source@example.com", "source-secret", 0.08);
  const destination = await createApp(path.join(root, "destination"), "目标旧站", "old@example.com", "old-secret", 0.5);
  const exportService = createExportService({
    repository: source.repo,
    credentialStore: source.store,
    dbPath: source.paths.dbPath,
    clock: () => new Date("2026-07-13T03:00:00.000Z")
  });
  const artifact = await exportService.exportEncryptedBackup(PASSWORD);
  const payload = await (await import("../src/backupCrypto.js")).decryptBackup(artifact.body, PASSWORD);
  const backupPath = path.join(root, "backup.gpfbackup");
  await writeFile(backupPath, artifact.body);
  source.repo.close();
  destination.repo.close();
  return {
    root,
    source,
    destination,
    backupPath,
    payload,
    async cleanup() { await rm(root, { recursive: true, force: true }); }
  };
}

async function createApp(root, name, email, password, rate) {
  const paths = {
    rootDir: root,
    dataDir: path.join(root, "data"),
    dbPath: path.join(root, "data", "prices.db"),
    credentialVaultPath: path.join(root, "data", "credentials.vault")
  };
  const protector = {
    async protect(value) { return Buffer.from(value).toString("base64"); },
    async unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
  };
  const store = createCredentialStore({ vaultPath: paths.credentialVaultPath, protector });
  const repo = createRepository({ dbPath: paths.dbPath });
  const site = repo.createSite({ name, baseUrl: `https://${name === "源站点" ? "source" : "old"}.example.com`, providerId: "sub2api" });
  repo.saveCollection(site.id, { groups: [sampleGroup(rate)] }, "2026-07-13T00:00:00.000Z");
  await store.set(`site:${site.id}`, { email, password });
  return { paths, store, repo };
}

function sampleGroup(rate) {
  return {
    groupId: "default",
    groupName: "默认组",
    platform: "openai",
    status: "active",
    subscriptionType: "",
    billingType: "",
    description: "",
    baseRateMultiplier: rate,
    userRateMultiplier: null,
    effectiveRateMultiplier: rate,
    peakRate: { enabled: false, start: "", end: "", multiplier: 1, effectiveMultiplier: rate }
  };
}

async function destinationBytes(paths) {
  return {
    database: await readFile(paths.dbPath),
    credentials: await readFile(paths.credentialVaultPath)
  };
}

function restoreFixtureBackup(fixture) {
  return restoreEncryptedBackup({
    backupPath: fixture.backupPath,
    password: PASSWORD,
    paths: fixture.destination.paths,
    credentialStore: fixture.destination.store,
    assertServiceStopped: async () => {}
  });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
