import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { encryptBackup } from "./backupCrypto.js";
import { ratesToCsv } from "./exporters.js";

export function createExportService({
  repository,
  credentialStore,
  dbPath,
  readFileImpl = readFile,
  clock = () => new Date()
}) {
  if (!repository || !credentialStore || !dbPath) throw new Error("ExportService 缺少必要依赖");

  async function exportDataJson() {
    const now = clock();
    const snapshot = repository.exportPublicData(now.toISOString());
    return artifact(JSON.stringify(snapshot, null, 2), "data", "json", "application/json; charset=utf-8", now);
  }

  async function exportRatesCsv() {
    const now = clock();
    const snapshot = repository.exportPublicData(now.toISOString());
    return artifact(`\uFEFF${ratesToCsv(snapshot.rates)}`, "rates", "csv", "text/csv; charset=utf-8", now);
  }

  async function exportEncryptedBackup(password) {
    const now = clock();
    repository.checkpoint();
    const databaseBytes = await readFileImpl(dbPath);
    const credentials = await credentialStore.exportAll();
    const payload = {
      payloadVersion: 1,
      createdAt: now.toISOString(),
      database: {
        encoding: "base64",
        sha256: createHash("sha256").update(databaseBytes).digest("hex"),
        content: databaseBytes.toString("base64")
      },
      credentials
    };
    return artifact(
      await encryptBackup(payload, password),
      "backup",
      "gpfbackup",
      "application/octet-stream",
      now
    );
  }

  return { exportDataJson, exportRatesCsv, exportEncryptedBackup };
}

function artifact(body, label, extension, contentType, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return {
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
    filename: `group-price-${label}-${stamp}.${extension}`,
    contentType
  };
}
