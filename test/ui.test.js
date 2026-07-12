import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard exposes management, filtering, sorting, pagination and history controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of [
    "view-rates",
    "view-changes",
    "view-sites",
    "view-settings",
    "site-dialog",
    "bulk-dialog",
    "history-dialog",
    "category-filter",
    "tag-filter",
    "platform-filter",
    "group-status-filter",
    "auth-filter",
    "rate-visibility",
    "sort-field",
    "sort-direction",
    "page-prev",
    "page-next",
    "refresh-all",
    "changes-body",
    "site-provider",
    "site-auth-mode",
    "credential-email",
    "credential-password",
    "credential-access-token",
    "credential-user-id",
    "api-key-status",
    "rotate-api-key"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /type=["']password["']/i);
  for (const id of ["credential-password", "credential-access-token"]) {
    const input = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] ?? "";
    assert.ok(input, `missing sensitive input #${id}`);
    assert.doesNotMatch(input, /\svalue=/i);
  }
});

test("dashboard script uses management APIs and explicit auth actions", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const endpoint of ["/api/sites", "/api/categories", "/api/tags", "/api/rates", "/api/changes", "/credentials", "/settings/api-key", "/history", "/refresh", "/login", "/import-edge"]) {
    assert.ok(script.includes(endpoint), `missing API usage ${endpoint}`);
  }
  assert.match(script, /sortBy/);
  assert.match(script, /pageSize/);
  assert.match(script, /loading/i);
  assert.match(script, /empty/i);
  assert.match(script, /error/i);
  assert.match(script, /safeHandler/);
});

test("latest rates can switch hidden groups and persist hide or restore actions", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  const visibility = html.match(/<select[^>]*id=["']rate-visibility["'][^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  assert.match(visibility, /value=["']visible["'][^>]*>正常显示/);
  assert.match(visibility, /value=["']hidden["'][^>]*>已隐藏/);
  assert.match(script, /visibility:\s*\$\(["']#rate-visibility["']\)\.value/);
  assert.match(script, /data-action=["']hide["']/);
  assert.match(script, /data-action=["']restore["']/);
  assert.ok(script.includes("/groups/"));
  assert.ok(script.includes("/hidden"));
  assert.match(script, /hide:\s*["']PUT["']/);
  assert.match(script, /restore:\s*["']DELETE["']/);
  assert.match(script, /state\.rates\.page\s*=\s*1[\s\S]*?await loadRates\(\)/);
});

test("settings exposes ordinary exports and password-safe encrypted backup controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of [
    "export-json",
    "export-csv",
    "backup-password",
    "backup-password-confirm",
    "export-encrypted-backup"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const id of ["backup-password", "backup-password-confirm"]) {
    const input = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] ?? "";
    assert.ok(input, `missing password input #${id}`);
    assert.match(input, /\stype=["']password["']/i);
    assert.match(input, /\sautocomplete=["']new-password["']/i);
    assert.doesNotMatch(input, /\svalue=/i);
  }
});

test("dashboard script downloads exports and clears encrypted backup passwords", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const endpoint of [
    "/api/exports/data.json",
    "/api/exports/rates.csv",
    "/api/exports/encrypted-backup"
  ]) {
    assert.ok(script.includes(endpoint), `missing export API usage ${endpoint}`);
  }
  assert.match(script, /response\.blob\(\)/);
  assert.match(script, /document\.createElement\(["']a["']\)/);
  assert.match(script, /\.download\s*=/);
  assert.match(script, /URL\.createObjectURL\(/);
  assert.match(script, /URL\.revokeObjectURL\(/);
  assert.match(script, /password\.length\s*<\s*10/);
  assert.match(script, /password\s*!==\s*confirmation/);
  assert.match(script, /body:\s*\{\s*password\s*\}/);
  assert.match(script, /finally\s*\{[\s\S]*?#backup-password[\s\S]*?\.value\s*=\s*["']["'][\s\S]*?#backup-password-confirm[\s\S]*?\.value\s*=\s*["']["']/);
});
