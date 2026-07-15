import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard layout contains responsive overflow guards for dense tables and forms", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.workspace\s*\{[^}]*max-width:\s*100%/s);
  assert.match(styles, /\.filter-bar[^\{]*\{[^}]*repeat\(auto-fit,\s*minmax\(/s);
  assert.match(styles, /\.data-surface\s*\{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.table-scroll\s*\{[^}]*overscroll-behavior-inline:\s*contain/s);
  assert.match(styles, /\.settings-block\s*\{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.inline-form[^\{]*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.nav\s*\{[^}]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s);
});

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
  assert.match(html, /当前账号倍率/);
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
  assert.match(script, /siteCurrentRateMultiplier/);
  assert.match(script, /当前账号未选择固定倍率|账号存在多个当前倍率/);
  assert.match(script, /Number\(rate\.siteCurrentRateMultiplier\)\s*>\s*Number\(rate\.effectiveRateMultiplier\)/);
  assert.match(script, /登录账号当前倍率高于该分组实际倍率|GPT 用 1111|Grok 用密钥 grok|modelFamily/);
  assert.match(script, /function safeExternalUrl\(value, providerId\)/);
  assert.match(script, /providerId === ["']newapi["'][\s\S]*?["']\/console\/token["']/);
  assert.match(script, /data-provider-id=/);
  assert.match(script, /rate-value\s+overpriced/);
});

test("current account rate above effective rate uses a red warning style", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.rate-value\.overpriced\s*\{[^}]*color:\s*var\(--vermilion\)/s);
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


test("settings and rate filters expose independent GPT and Grok pricing domains", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "model-family-filter", "metric-gpt-min", "metric-grok-min", "dynamic-ratio-form",
    "dynamic-gpt-enabled", "dynamic-gpt-group", "dynamic-gpt-service-multiplier", "dynamic-gpt-minimum", "dynamic-gpt-maximum", "dynamic-gpt-threshold", "dynamic-gpt-status",
    "dynamic-grok-enabled", "dynamic-grok-group", "dynamic-grok-service-multiplier", "dynamic-grok-minimum", "dynamic-grok-maximum", "dynamic-grok-threshold", "dynamic-grok-status"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  assert.ok(script.includes("/api/settings/dynamic-ratio"));
  assert.match(script, /modelFamily/);
  assert.match(script, /policies/);
  assert.match(html, /Grok 渠道分组待配置/);
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

test("notification center exposes accessible management, subscription, log and policy controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of [
    "view-notifications",
    "notification-kpis",
    "notification-enabled-count",
    "notification-success-count",
    "notification-failed-count",
    "notification-low-balance-count",
    "notification-channels-body",
    "add-notification-channel",
    "notification-dialog",
    "notification-form",
    "notification-name",
    "notification-type",
    "notification-config-fields",
    "notification-sites",
    "notification-events",
    "notification-logs-body",
    "notification-policy-form",
    "policy-min-ratio-change",
    "policy-balance-cooldown",
    "policy-failure-cooldown",
    "policy-retry-attempts"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);

  assert.match(html, /data-view=["']notifications["'][^>]*>[\s\S]*?通知中心/);
  for (const [value, label] of [["telegram", "Telegram"], ["webhook", "Webhook"], ["email", "Email"], ["wecom", "企业微信"], ["dingtalk", "钉钉"], ["feishu", "飞书"]]) {
    assert.match(html, new RegExp(`<option[^>]*value=["']${value}["'][^>]*>${label}</option>`));
  }
  for (const eventType of ["ratio_changed", "group_added", "group_removed", "balance_low", "auth_failed", "collection_failed"]) {
    assert.match(html, new RegExp(`type=["']checkbox["'][^>]*value=["']${eventType}["']`));
  }
  assert.match(html, /<select[^>]*id=["']notification-sites["'][^>]*multiple/);
  assert.match(html, /未选择站点时订阅全部站点/);
  assert.match(html, /<dialog[^>]*id=["']notification-dialog["'][^>]*aria-labelledby=/);
});

test("notification editor declares type-specific fields without embedding saved secrets", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "notification-bot-token", "notification-chat-id", "notification-webhook-url",
    "notification-webhook-method", "notification-webhook-headers", "notification-smtp-host",
    "notification-smtp-port", "notification-smtp-username", "notification-smtp-password",
    "notification-email-from", "notification-email-recipients", "notification-platform-webhook-url",
    "notification-signing-secret"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);

  assert.match(html, /<textarea[^>]*id=["']notification-webhook-headers["']/);
  for (const id of ["notification-bot-token", "notification-smtp-password", "notification-signing-secret"]) {
    const input = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] ?? "";
    assert.match(input, /type=["']password["']/i);
    assert.doesNotMatch(input, /\svalue=/i);
  }
  assert.match(script, /function clearNotificationSecrets\(\)[\s\S]*?#notification-bot-token[\s\S]*?#notification-smtp-password[\s\S]*?#notification-signing-secret/);
  assert.match(script, /configFields/);
  assert.doesNotMatch(script, /channel\.config\.(botToken|password|secret)/);
});

test("notification UI uses existing APIs, BASE_PATH routing and destructive confirmations", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const endpoint of ["/api/notifications/channels", "/api/notifications/logs", "/api/notifications/policy", "/api/sites"]) {
    assert.ok(script.includes(endpoint), `missing API usage ${endpoint}`);
  }
  assert.match(script, /appPath\(`\/api\/notifications\/channels\/\$\{[^}]+\}\/test`\)/);
  assert.match(script, /confirm\([^)]*删除通知渠道/);
  assert.match(script, /JSON\.parse\([^)]*notification-webhook-headers/);
  assert.match(script, /subscriptions:/);
  assert.match(script, /eventTypes:/);
  assert.match(script, /balanceCooldownHours/);
  assert.match(script, /failureCooldownMinutes/);
  assert.match(script, /retryAttempts/);
});

test("sites and changes expose balance and recent-change summaries", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const id of [
    "site-balance-kpis", "balance-known-count", "balance-total-value", "balance-low-count",
    "balance-issue-count", "site-balance-threshold", "changes-summary", "changes-total-count",
    "changes-up-count", "changes-down-count", "changes-added-count", "changes-removed-count"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  assert.match(script, /balanceThresholdUsd:\s*[^,\n]+/);
  assert.match(script, /balanceStatus/);
  assert.match(script, /balanceUsd/);
  assert.match(script, /ratio_changed/);
  assert.match(script, /group_added/);
  assert.match(script, /group_removed/);
  assert.match(styles, /\.balance-status\.(known|low)/);
  assert.match(styles, /\.balance-status\.(unknown|unavailable)/);
  assert.match(styles, /\.balance-status\.error/);
  assert.match(styles, /\.notification-table[^\{]*\{[^}]*min-width:/s);
});
