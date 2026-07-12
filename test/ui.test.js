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
