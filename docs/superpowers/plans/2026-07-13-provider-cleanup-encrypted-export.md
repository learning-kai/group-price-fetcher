# Provider Cleanup and Encrypted Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the visible Uling19 Provider, migrate existing sites to sub2api, add safe JSON/CSV exports, and provide a portable password-encrypted full backup with an offline restore command.

**Architecture:** Keep ordinary exports credential-free and build them from repository-owned snapshots. Build full backups as versioned JSON envelopes encrypted with scrypt-derived AES-256-GCM keys; include a checkpointed SQLite image plus DPAPI-decrypted credentials only inside the encrypted payload. Restore only while the service is stopped, validate before replacement, and roll back the database and credential vault as one unit.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, `node:crypto`, Windows DPAPI, Node test runner, browser Blob downloads.

---

## File Structure

- Create `src/backupCrypto.js`: versioned encryption/decryption envelope; no filesystem or application dependencies.
- Create `src/exportService.js`: ordinary exports and encrypted-backup payload assembly.
- Create `src/restoreBackup.js`: offline restore transaction, validation, rollback, and port guard.
- Create `src/restoreBackupCli.js`: hidden password prompt and command-line entry point.
- Create `test/backupCrypto.test.js`: password, tamper, and plaintext-leak tests.
- Create `test/exportService.test.js`: ordinary and encrypted export behavior.
- Create `test/restoreBackup.test.js`: restore success and rollback behavior.
- Modify `src/storage.js`: v4 Provider migration, public export snapshot, WAL checkpoint.
- Modify `src/credentialStore.js`: in-memory full credential read/replace operations.
- Modify `src/providerRegistry.js`: expose only sub2api and NewAPI; default to sub2api.
- Modify `src/routes.js`: local-only download endpoints.
- Modify `src/server.js`: wire export service and send binary responses.
- Modify `public/index.html` and `public/app.js`: functional download controls.
- Modify `package.json` and `README.md`: restore script and operational documentation.

The workspace is not a valid Git repository. Do not initialize Git or fabricate commits; each focused green test command is the implementation checkpoint.

### Task 1: Remove Uling19 and Migrate Existing Sites

**Files:**
- Modify: `src/providerRegistry.js`
- Modify: `src/storage.js`
- Modify: `test/storage.test.js`
- Create: `test/providerRegistry.test.js`

- [ ] **Step 1: Write the failing Provider registry test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { getProvider, listProviders } from "../src/providerRegistry.js";

test("registry exposes only sub2api and NewAPI", () => {
  assert.deepEqual(listProviders().map((item) => item.id), ["sub2api", "newapi"]);
  assert.equal(getProvider().id, "sub2api");
  assert.throws(() => getProvider("uling-gateway"), /未知 provider/);
});
```

- [ ] **Step 2: Write the failing v4 migration test**

Append to `test/storage.test.js`. Create a current database, force one site's Provider and `user_version` back to the v3 state with `DatabaseSync`, reopen it through `createRepository`, and assert only the Provider changes:

```js
test("v4 migration maps legacy Uling sites to sub2api", async () => {
  const fixture = await createFixture();
  const site = fixture.repo.createSite({ name: "旧站", baseUrl: "https://legacy.example.com" });
  fixture.repo.close();
  const raw = new DatabaseSync(fixture.dbPath);
  raw.prepare("UPDATE sites SET provider_id = 'uling-gateway' WHERE id = ?").run(site.id);
  raw.exec("PRAGMA user_version = 3");
  raw.close();

  const migrated = createRepository({ dbPath: fixture.dbPath });
  assert.equal(migrated.getSite(site.id).providerId, "sub2api");
  assert.equal(migrated.getSite(site.id).baseUrl, "https://legacy.example.com");
  migrated.close();
  const verification = new DatabaseSync(fixture.dbPath);
  assert.equal(verification.prepare("PRAGMA user_version").get().user_version, 4);
  verification.close();
});
```

Update the fixture to return `dbPath` and avoid closing the same repository twice.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --disable-warning=ExperimentalWarning --test test/providerRegistry.test.js test/storage.test.js
```

Expected: the registry still includes `uling-gateway`, the default is wrong, and the reopened v3 database remains on the legacy Provider.

- [ ] **Step 4: Implement the v4 migration and defaults**

In `src/storage.js`, after v3:

```js
version = db.prepare("PRAGMA user_version").get().user_version;
if (version < 4) db.exec(`
  BEGIN;
  UPDATE sites SET provider_id = 'sub2api' WHERE provider_id = 'uling-gateway';
  PRAGMA user_version = 4;
  COMMIT;
`);
```

Change `normalizeSiteInput` to default `providerId` to `sub2api`. In `src/providerRegistry.js`, remove the Uling provider registration and use:

```js
const providers = new Map([
  [sub2apiProvider.id, sub2apiProvider],
  [newApiProvider.id, newApiProvider]
]);

export function getProvider(providerId = sub2apiProvider.id) {
  const provider = providers.get(providerId);
  if (!provider) throw new Error(`未知 provider：${providerId}`);
  return provider;
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the Step 3 command. Expected: all focused tests pass and no non-Provider site fields change.

### Task 2: Add Repository and Credential Export Boundaries

**Files:**
- Modify: `src/storage.js`
- Modify: `src/credentialStore.js`
- Modify: `test/storage.test.js`
- Modify: `test/credentialStore.test.js`

- [ ] **Step 1: Write failing repository export tests**

Create 550 current rates and 520 change events so the test proves export is not silently limited by existing 500-row page caps. Assert `exportPublicData()` omits `authUsername`, `credentialConfigured`, `credentialRef`, settings, and API Key hashes:

```js
const exported = fixture.repo.exportPublicData("2026-07-13T03:00:00.000Z");
assert.equal(exported.formatVersion, 1);
assert.equal(exported.rates.length, 550);
assert.equal(exported.changes.length, 520);
assert.equal(JSON.stringify(exported).includes("external_api_key_hash"), false);
assert.equal(JSON.stringify(exported).includes("credential"), false);
```

Also test `checkpoint()` returns without changing data.

- [ ] **Step 2: Write failing credential vault tests**

Append:

```js
await store.set("site:1", { email: "one@example.com", password: "secret-one" });
const entries = await store.exportAll();
entries["site:1"].password = "mutated";
assert.equal((await store.get("site:1")).password, "secret-one");

await store.replaceAll({ "site:2": { accessToken: "token-two", userId: "2" } });
assert.equal(await store.get("site:1"), null);
assert.deepEqual(await store.get("site:2"), { accessToken: "token-two", userId: "2" });
```

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/storage.test.js test/credentialStore.test.js
```

Expected: `exportPublicData`, `checkpoint`, `exportAll`, and `replaceAll` do not exist.

- [ ] **Step 4: Implement repository-owned public export**

Add direct unpaginated queries in `storage.js`; do not loop through capped public query methods:

```js
function exportPublicData(exportedAt = iso(clock())) {
  const sites = db.prepare(siteSelect()).all().map(mapSite).map((site) => ({
    id: site.id,
    name: site.name,
    baseUrl: site.baseUrl,
    providerId: site.providerId,
    categoryId: site.categoryId,
    categoryName: site.categoryName,
    tags: site.tags,
    enabled: site.enabled,
    authStatus: site.authStatus,
    lastCollectedAt: site.lastCollectedAt,
    updatedAt: site.updatedAt
  }));
  const rates = db.prepare(`
    SELECT r.*, s.name AS site_name, s.base_url, s.auth_status, c.name AS category_name
    FROM rate_versions r JOIN sites s ON s.id = r.site_id
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE r.valid_to IS NULL ORDER BY s.name, r.group_name, r.id
  `).all().map(mapRate);
  const changes = db.prepare(`
    SELECT e.*, s.name AS site_name, s.base_url, c.name AS category_name
    FROM change_events e JOIN sites s ON s.id = e.site_id
    LEFT JOIN categories c ON c.id = s.category_id
    ORDER BY e.created_at DESC, e.id DESC
  `).all().map(mapChange);
  return { formatVersion: 1, exportedAt, sites, rates, changes };
}

function checkpoint() {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
```

Return both methods from the repository.

- [ ] **Step 5: Implement credential snapshot replacement**

Inside the existing credential-store mutex:

```js
async function exportAll() {
  return mutex(async () => structuredClone(await readVault()));
}

async function replaceAll(entries) {
  validateVaultEntries(entries);
  return mutex(async () => {
    await writeVault(structuredClone(entries));
    return true;
  });
}
```

`validateVaultEntries` must require an object, `site:<positive integer>` keys, nonempty credential objects, and string values by reusing `validateCredentials`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all tests pass and the exported public object contains no secret-bearing metadata.

### Task 3: Implement the Versioned Encryption Envelope

**Files:**
- Create: `src/backupCrypto.js`
- Create: `test/backupCrypto.test.js`

- [ ] **Step 1: Write failing crypto behavior tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { decryptBackup, encryptBackup } from "../src/backupCrypto.js";

const payload = {
  payloadVersion: 1,
  createdAt: "2026-07-13T00:00:00.000Z",
  database: { encoding: "base64", sha256: "abc", content: "sqlite-base64" },
  credentials: { "site:1": { email: "user@example.com", password: "plain-secret" } }
};

test("encrypted backup round-trips without plaintext", async () => {
  const encrypted = await encryptBackup(payload, "correct horse battery staple");
  assert.deepEqual(await decryptBackup(encrypted, "correct horse battery staple"), payload);
  assert.equal(encrypted.includes("plain-secret"), false);
  assert.equal(encrypted.includes("user@example.com"), false);
  assert.equal(encrypted.includes("SQLite format 3"), false);
});

test("wrong password and tampering are rejected", async () => {
  const encrypted = await encryptBackup(payload, "correct horse battery staple");
  await assert.rejects(() => decryptBackup(encrypted, "wrong password value"), /密码错误或备份已损坏/);
  const envelope = JSON.parse(encrypted);
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(() => decryptBackup(JSON.stringify(envelope), "correct horse battery staple"), /密码错误或备份已损坏/);
});

test("backup password must contain at least ten characters", async () => {
  await assert.rejects(() => encryptBackup(payload, "short"), /至少 10 个字符/);
});
```

- [ ] **Step 2: Run crypto tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/backupCrypto.test.js
```

Expected: module not found.

- [ ] **Step 3: Implement encryption and decryption**

Use constants shared by both paths:

```js
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AAD = Buffer.from("group-price-fetcher-backup:v1", "utf8");
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function deriveKey(password, salt) {
  validatePassword(password);
  return scrypt(password, salt, 32, KDF);
}
```

`encryptBackup(payload, password)` must generate 16-byte salt and 12-byte IV, call `cipher.setAAD(AAD)`, and return `JSON.stringify` of the exact v1 envelope from the spec. `decryptBackup(serialized, password)` must validate every discriminator and base64 field before deriving the key; wrap GCM failures in an error with code `BACKUP_DECRYPT_FAILED` and message `密码错误或备份已损坏`.

- [ ] **Step 4: Run crypto tests and verify GREEN**

Run the Step 2 command. Expected: all crypto tests pass.

### Task 4: Build Ordinary and Encrypted Export Services

**Files:**
- Create: `src/exportService.js`
- Create: `test/exportService.test.js`
- Modify: `src/exporters.js`

- [ ] **Step 1: Write failing ordinary export tests**

Test `createExportService({ repository, credentialStore, dbPath, readFileImpl, clock })`:

```js
const json = await service.exportDataJson();
assert.equal(json.contentType, "application/json; charset=utf-8");
assert.match(json.filename, /^group-price-data-\d{8}-\d{6}\.json$/);
assert.equal(JSON.parse(json.body).rates.length, 550);
assert.equal(json.body.includes("plain-secret"), false);

const csv = await service.exportRatesCsv();
assert.equal(csv.contentType, "text/csv; charset=utf-8");
assert.equal(csv.body.startsWith("\uFEFFsite_name,"), true);
assert.equal(csv.body.split("\n").length, 552);
```

- [ ] **Step 2: Write failing encrypted export tests**

```js
const result = await service.exportEncryptedBackup("correct horse battery staple");
assert.equal(result.contentType, "application/octet-stream");
assert.match(result.filename, /\.gpfbackup$/);
assert.equal(result.body.includes("plain-secret"), false);
const payload = await decryptBackup(result.body, "correct horse battery staple");
assert.equal(payload.database.sha256, createHash("sha256").update(databaseBytes).digest("hex"));
assert.deepEqual(payload.credentials["site:1"], { email: "user@example.com", password: "plain-secret" });
assert.deepEqual(events, ["checkpoint", "read-database", "read-credentials"]);
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/exportService.test.js
```

Expected: module not found or missing service methods.

- [ ] **Step 4: Add stable current-rate CSV conversion**

Export a new `ratesToCsv(rates)` from `src/exporters.js`. It must use the current `csvCell` helper and these fixed columns:

```js
const columns = [
  "site_name", "site_url", "category", "group_id", "group_name", "platform",
  "status", "base_rate_multiplier", "user_rate_multiplier", "effective_rate_multiplier",
  "rpm_limit", "description", "updated_at"
];
```

The service prepends `\uFEFF` and retains the trailing newline.

- [ ] **Step 5: Implement export-service assembly**

```js
export function createExportService({ repository, credentialStore, dbPath, readFileImpl = readFile, clock = () => new Date() }) {
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
    return artifact(await encryptBackup(payload, password), "backup", "gpfbackup", "application/octet-stream", now);
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
```

`artifact` returns `{ body: Buffer, filename, contentType }`; each operation captures the clock once so filename and payload timestamps cannot disagree at a second boundary.

- [ ] **Step 6: Run export tests and verify GREEN**

Run the Step 3 command. Expected: all ordinary and encrypted export tests pass.

### Task 5: Add Local-Only HTTP Download Endpoints

**Files:**
- Modify: `src/routes.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing HTTP download tests**

Extend the server fixture with a fake `exportService`. Assert:

```js
const response = await fetch(`${fixture.baseUrl}/api/exports/data.json`);
assert.equal(response.status, 200);
assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
assert.match(response.headers.get("content-disposition"), /attachment; filename="group-price-data-.*\.json"/);
assert.deepEqual(await response.json(), { formatVersion: 1, sites: [], rates: [], changes: [] });
```

Repeat for CSV and encrypted POST. Verify the encrypted endpoint receives the password but the response and error log do not contain it. Call the router with `remoteAddress: "192.168.1.8"` and verify management authorization rejects all three routes.

- [ ] **Step 2: Run server tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/server.test.js
```

Expected: export routes return 404 and the server cannot send download metadata.

- [ ] **Step 3: Wire the export service**

In `createDefaultServices`, construct it from the existing repository, credential store, and `paths.dbPath`. Pass it through the services object.

In `routes.js`, after management authorization:

```js
if (method === "GET" && pathname === "/api/exports/data.json") {
  return downloadResponse(await exportService.exportDataJson());
}
if (method === "GET" && pathname === "/api/exports/rates.csv") {
  return downloadResponse(await exportService.exportRatesCsv());
}
if (method === "POST" && pathname === "/api/exports/encrypted-backup") {
  return downloadResponse(await exportService.exportEncryptedBackup(body.password));
}
```

`downloadResponse` must set status 200 and only these headers:

```js
{
  "Content-Type": artifact.contentType,
  "Content-Disposition": `attachment; filename="${artifact.filename}"`,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
}
```

- [ ] **Step 4: Add binary response support**

Change the request handler to call a generic sender. For `Buffer` bodies, set the supplied headers plus exact `Content-Length`; preserve current JSON and 204 behavior. Do not pass download bodies through `JSON.stringify`.

- [ ] **Step 5: Run server tests and verify GREEN**

Run the Step 2 command. Expected: all download and existing route tests pass.

### Task 6: Implement Offline Restore With Rollback

**Files:**
- Create: `src/restoreBackup.js`
- Create: `src/restoreBackupCli.js`
- Create: `test/restoreBackup.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing restore-success test**

Use temporary source and destination app roots. Create a real source repository and DPAPI-independent credential store fake, export an encrypted backup, then restore it:

```js
const restored = await restoreEncryptedBackup({
  backupPath,
  password: "correct horse battery staple",
  paths: destinationPaths,
  credentialStore: destinationCredentialStore,
  assertServiceStopped: async () => {},
  clock: () => new Date("2026-07-13T04:00:00.000Z")
});
assert.equal(restored.siteCount, 1);
assert.equal(createRepository({ dbPath: destinationPaths.dbPath }).listSites().total, 1);
assert.deepEqual(await destinationCredentialStore.get("site:1"), sourceCredentials);
assert.equal(restored.databaseBackupPath.endsWith(".restore-20260713-040000.bak"), true);
```

- [ ] **Step 2: Write failing validation and rollback tests**

Cover these independent failures:

- Service-port guard rejects before reading or replacing files.
- Wrong password leaves destination DB and vault byte-identical.
- Payload database SHA mismatch leaves destination unchanged.
- Candidate SQLite missing `sites`, `rate_versions`, or `change_events` is rejected.
- Injected `credentialStore.replaceAll` failure after DB replacement restores both original files.

- [ ] **Step 3: Run restore tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/restoreBackup.test.js
```

Expected: module not found.

- [ ] **Step 4: Implement restore validation and transaction**

`restoreEncryptedBackup` performs this exact order:

```js
await assertServiceStopped();
const envelope = await readFile(backupPath, "utf8");
const payload = validatePayload(await decryptBackup(envelope, password));
const databaseBytes = Buffer.from(payload.database.content, "base64");
verifySha256(databaseBytes, payload.database.sha256);
await writeFile(candidatePath, databaseBytes, { flag: "wx" });
validateSqliteCandidate(candidatePath, ["sites", "rate_versions", "change_events"]);
await backupIfPresent(paths.dbPath, databaseBackupPath);
await backupIfPresent(paths.credentialVaultPath, credentialBackupPath);
try {
  await replaceDatabase(candidatePath, paths.dbPath);
  await credentialStore.replaceAll(payload.credentials);
  const repository = createRepository({ dbPath: paths.dbPath });
  const siteCount = repository.listSites({ page: 1, pageSize: 1 }).total;
  repository.close();
  return { siteCount, databaseBackupPath, credentialBackupPath };
} catch (error) {
  await restorePairFromBackups(...);
  throw error;
} finally {
  await rm(candidatePath, { force: true });
}
```

Use dependency injection for filesystem functions in tests. Keep the candidate and replacements inside `paths.dataDir` so renames remain on one volume. Backup the `-wal` and `-shm` files only if present, and remove stale destination sidecars before opening the restored database.

- [ ] **Step 5: Implement the hidden CLI password prompt and port guard**

`restoreBackupCli.js` accepts exactly one backup path argument, requires a TTY, reads the password with raw-mode character masking, and never accepts a password argument or environment variable. `assertServiceStopped` attempts a TCP connection to `127.0.0.1:${PORT || 5177}` and rejects if it connects.

Add:

```json
"backup:restore": "node --disable-warning=ExperimentalWarning src/restoreBackupCli.js"
```

- [ ] **Step 6: Run restore tests and verify GREEN**

Run the Step 3 command. Expected: all success, validation, and rollback tests pass.

### Task 7: Add Functional Export Controls and Documentation

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/ui.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write failing functional UI contract tests**

Require IDs:

```js
for (const id of [
  "export-json", "export-csv", "backup-password", "backup-password-confirm", "export-encrypted-backup"
]) assert.match(html, new RegExp(`id=["']${id}["']`));
```

Assert `app.js` references all three endpoint paths, uses `response.blob()`, creates a temporary `<a download>`, revokes the object URL, validates 10 characters and equality, and clears both password inputs in `finally`. Do not add CSS or layout assertions.

- [ ] **Step 2: Run UI tests and verify RED**

```powershell
node --disable-warning=ExperimentalWarning --test test/ui.test.js
```

Expected: missing control IDs and endpoint handlers.

- [ ] **Step 3: Add semantic controls**

Add one un-nested settings block with two ordinary export buttons and one password form. Password fields use `type="password"`, `autocomplete="new-password"`, and have no `value` attribute.

- [ ] **Step 4: Implement safe browser downloads**

```js
async function downloadArtifact(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `导出失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "export.bin";
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

The encrypted handler validates both passwords client-side, sends only `{ password }`, and clears both inputs in `finally` whether the request passes or fails.

- [ ] **Step 5: Document backup and restore operations**

Update README with:

- Uling19 removal and automatic v4 migration.
- Difference between ordinary data exports and full encrypted backups.
- AES-GCM/scrypt password requirement and Edge Profile exclusion.
- Exact offline restore command and requirement to stop port 5177 first.
- Automatic pre-restore backup and rollback behavior.
- Warning that losing the backup password makes the file unrecoverable.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run the Step 2 command. Expected: both functional UI tests pass; no layout tests exist.

### Task 8: Full Verification and Formal-Service Migration

**Files:**
- Verify only unless a failing test requires a scoped fix.

- [ ] **Step 1: Run syntax and full automated tests**

```powershell
node --check public\app.js
npm test
```

Expected: syntax exit 0 and every test passes with zero layout/visual tests.

- [ ] **Step 2: Run an isolated end-to-end backup/restore smoke test**

Use a temporary `GROUP_PRICE_FETCHER_HOME`. Through HTTP, create a sub2api site, store a fake credential, export JSON/CSV/full backup, verify ordinary exports omit the fake secret, stop the preview service, restore into a second temporary home, and verify the site plus credential round-trip. Delete only those verified `%TEMP%` roots.

Expected markers:

```text
ORDINARY_EXPORT_SMOKE_OK
ENCRYPTED_BACKUP_SMOKE_OK
OFFLINE_RESTORE_SMOKE_OK
```

- [ ] **Step 3: Audit encrypted and ordinary artifacts**

Search the ordinary exports and `.gpfbackup` bytes for the test email, password, Token, `SQLite format 3`, and API Key hash. Ordinary exports may contain none; encrypted backup may contain none before decryption. Decrypt with the test password and verify the database checksum and credentials.

- [ ] **Step 4: Back up and restart the formal service**

Identify the current PID listening on 5177, stop only that PID, checkpoint the real database, copy it to `prices.db.pre-v4-<timestamp>.bak`, start the same Node command from this workspace, and wait for `/health`.

- [ ] **Step 5: Verify the formal migration without mutating user records**

Check:

- `PRAGMA user_version` equals 4.
- Site count equals the pre-restart count.
- No site has `provider_id='uling-gateway'`.
- `/api/providers` returns only `sub2api,newapi`.
- Existing rates and change counts are not lower than pre-restart counts.
- `/api/exports/data.json` and `/api/exports/rates.csv` return attachments.
- stderr is empty.

Do not generate a real encrypted backup with user credentials during smoke verification unless the user explicitly requests one; crypto and isolated integration tests already cover that path.
