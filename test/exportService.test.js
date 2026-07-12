import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decryptBackup } from "../src/backupCrypto.js";
import { createExportService } from "../src/exportService.js";

test("ordinary exports contain complete public data and Excel-compatible CSV", async () => {
  const snapshot = publicSnapshot();
  const service = createExportService({
    repository: {
      exportPublicData(exportedAt) {
        assert.equal(exportedAt, "2026-07-13T03:00:00.000Z");
        return { ...snapshot, exportedAt };
      }
    },
    credentialStore: { async exportAll() { throw new Error("ordinary export must not read credentials"); } },
    dbPath: "unused.db",
    clock: () => new Date("2026-07-13T03:00:00.000Z")
  });

  const json = await service.exportDataJson();
  assert.equal(json.contentType, "application/json; charset=utf-8");
  assert.equal(json.filename, "group-price-data-20260713-030000.json");
  assert.equal(JSON.parse(json.body.toString("utf8")).rates.length, 2);
  assert.equal(json.body.includes("plain-secret"), false);

  const csv = await service.exportRatesCsv();
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  assert.equal(csv.filename, "group-price-rates-20260713-030000.csv");
  const csvText = csv.body.toString("utf8");
  assert.equal(csvText.startsWith("\uFEFFsite_name,site_url,category,"), true);
  assert.equal(csvText.split("\n").length, 4);
  assert.match(csvText, /Aurora API/);
  assert.match(csvText, /Nova Relay/);
});

test("encrypted backup checkpoints before reading database and credentials", async () => {
  const events = [];
  const databaseBytes = Buffer.from("SQLite format 3\0fixture database");
  const credentials = {
    "site:1": { email: "user@example.com", password: "plain-secret" }
  };
  const service = createExportService({
    repository: {
      checkpoint() { events.push("checkpoint"); },
      exportPublicData() { throw new Error("encrypted backup must not use public export"); }
    },
    credentialStore: {
      async exportAll() {
        events.push("read-credentials");
        return credentials;
      }
    },
    dbPath: "prices.db",
    readFileImpl: async (file) => {
      assert.equal(file, "prices.db");
      events.push("read-database");
      return databaseBytes;
    },
    clock: () => new Date("2026-07-13T04:05:06.000Z")
  });

  const result = await service.exportEncryptedBackup("correct horse battery staple");
  assert.equal(result.contentType, "application/octet-stream");
  assert.equal(result.filename, "group-price-backup-20260713-040506.gpfbackup");
  assert.equal(result.body.includes("plain-secret"), false);
  assert.equal(result.body.includes("SQLite format 3"), false);
  assert.deepEqual(events, ["checkpoint", "read-database", "read-credentials"]);

  const payload = await decryptBackup(result.body, "correct horse battery staple");
  assert.equal(payload.payloadVersion, 1);
  assert.equal(payload.createdAt, "2026-07-13T04:05:06.000Z");
  assert.equal(payload.database.encoding, "base64");
  assert.equal(payload.database.sha256, createHash("sha256").update(databaseBytes).digest("hex"));
  assert.equal(Buffer.from(payload.database.content, "base64").equals(databaseBytes), true);
  assert.deepEqual(payload.credentials, credentials);
});

function publicSnapshot() {
  return {
    formatVersion: 1,
    exportedAt: "",
    sites: [{ id: 1, name: "Aurora API", baseUrl: "https://aurora.example.com" }],
    rates: [
      rate(1, "Aurora API", "https://aurora.example.com", "default", "默认组", 0.08),
      rate(2, "Nova Relay", "https://nova.example.com", "claude", "Claude 专线", 0.12)
    ],
    changes: [{ id: 1, changeType: "ratio_changed" }]
  };
}

function rate(siteId, siteName, baseUrl, groupId, groupName, multiplier) {
  return {
    siteId,
    siteName,
    baseUrl,
    categoryName: "稳定",
    groupId,
    groupName,
    platform: "openai",
    status: "active",
    baseRateMultiplier: multiplier,
    userRateMultiplier: null,
    effectiveRateMultiplier: multiplier,
    rpmLimit: 60,
    description: "演示",
    validFrom: "2026-07-13T00:00:00.000Z"
  };
}
