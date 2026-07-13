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
    "site-rate-conversion-factor",
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

test("site editor supports portable sub2api tokens and Windows session capture", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /<option[^>]*value=["']sub2api-token["'][^>]*>/);
  for (const id of [
    "sub2api-token-credentials",
    "credential-sub2api-access-token",
    "credential-sub2api-refresh-token",
    "capture-browser-session"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const id of ["credential-sub2api-access-token", "credential-sub2api-refresh-token"]) {
    const input = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] ?? "";
    assert.match(input, /type=["']password["']/i);
    assert.doesNotMatch(input, /\svalue=/i);
  }

  assert.ok(script.includes("/capture-browser-session"));
  assert.match(script, /browserAuthSupported/);
  assert.match(script, /state\.browserAuthSupported[\s\S]*?edge-profile/);
  assert.match(script, /#site-auth-mode["']\)\.value\s*=\s*["']sub2api-token["']/);
  assert.match(script, /#credential-sub2api-access-token["']\)\.value\s*=\s*tokens\.accessToken/);
  assert.match(script, /#credential-sub2api-refresh-token["']\)\.value\s*=\s*tokens\.refreshToken/);
  assert.match(script, /authMode === ["']sub2api-token["'][\s\S]*?accessToken[\s\S]*?refreshToken/);
  assert.match(script, /function clearSiteCredentialFields\(\)[\s\S]*?#credential-sub2api-access-token[\s\S]*?#credential-sub2api-refresh-token/);
  assert.match(script, /closeSiteDialog/);
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

test("site form edits a positive rate conversion factor", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const input = html.match(/<input[^>]*id=["']site-rate-conversion-factor["'][^>]*>/)?.[0] ?? "";

  assert.match(input, /type=["']number["']/);
  assert.match(input, /min=["']0\.000001["']/);
  assert.match(input, /step=["']any["']/);
  assert.match(input, /value=["']1["']/);
  assert.match(script, /#site-rate-conversion-factor["']\)\.value\s*=\s*site\?\.rateConversionFactor\s*\?\?\s*1/);
  assert.match(script, /rateConversionFactor:\s*Number\(\$\(["']#site-rate-conversion-factor["']\)\.value\)/);
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

test("settings exposes encrypted site transfer import and export controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "transfer-export-form",
    "transfer-export-password",
    "transfer-export-password-confirm",
    "export-site-transfer",
    "transfer-import-form",
    "transfer-import-file",
    "transfer-import-password",
    "import-site-transfer",
    "transfer-import-result"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const id of ["transfer-export-password", "transfer-export-password-confirm", "transfer-import-password"]) {
    const input = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] ?? "";
    assert.match(input, /\stype=["']password["']/i);
    assert.doesNotMatch(input, /\svalue=/i);
  }
  assert.ok(script.includes("/api/transfers/sites/export"));
  assert.ok(script.includes("/api/transfers/sites/import"));
  assert.match(script, /\.gpftransfer/);
  assert.match(script, /\.text\(\)/);
  assert.match(script, /needsCredentials/);
  assert.match(script, /finally\s*\{[\s\S]*?#transfer-export-password[\s\S]*?\.value\s*=\s*["']["']/);
  assert.match(script, /finally\s*\{[\s\S]*?#transfer-import-password[\s\S]*?\.value\s*=\s*["']["']/);
});
