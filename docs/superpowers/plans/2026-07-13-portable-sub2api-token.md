# Portable sub2api Token Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portable sub2api token mode that can be extracted from a Windows Edge Profile, edited on Linux, refreshed at runtime, and transported in `.gpftransfer`.

**Architecture:** Treat `sub2api-token` as a stored-vault authentication mode, separate from the Windows-only `edge-profile` source. AuthManager owns validation, refresh, rotation persistence, and explicit browser-session extraction; routes expose capability metadata and a no-store extraction endpoint; the existing site dialog and transfer service consume the new contract.

**Tech Stack:** Node.js ESM, built-in `node:test`, SQLite, browser DOM JavaScript, AES/DPAPI credential vaults, systemd, Caddy.

---

### Task 1: Portable Token Authentication Core

**Files:**
- Modify: `test/authManager.test.js`
- Modify: `src/authManager.js`
- Modify: `src/storage.js`

- [ ] **Step 1: Write failing AuthManager tests**

Add tests proving that a valid stored token is reused, an expired token is refreshed and persisted, credential configuration accepts an optional Refresh Token, and browser extraction returns the validated session without changing repository configuration:

```js
test("sub2api token mode reuses access and persists rotated refresh credentials", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: {
      async get() { return { accessToken: "expired", refreshToken: "refresh-1" }; },
      async set(reference, value) { writes.push({ reference, value }); }
    },
    browserAdapter: fakeBrowser({}),
    fetchImpl: authFetch({ refreshedAccess: "access-2", refreshedRefresh: "refresh-2", validTokens: ["access-2"] })
  });
  const result = await manager.getAccess({ ...site, authMode: "sub2api-token" });
  assert.equal(result.token, "access-2");
  assert.deepEqual(writes[0], {
    reference: "site:7",
    value: { accessToken: "access-2", refreshToken: "refresh-2" }
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --disable-warning=ExperimentalWarning --test test/authManager.test.js`

Expected: failures for unsupported `sub2api-token` and missing `captureBrowserSession`.

- [ ] **Step 3: Implement the minimal AuthManager behavior**

Add `sub2api-token` to `AUTH_MODES`, accept `{ accessToken, refreshToken }` in `configureCredentials`, and add:

```js
async function getStoredTokenAccess(site, options) {
  const credentials = await requireCredentials(site);
  if (!options.forceRefresh && credentials.accessToken
    && (await validateToken(site.baseUrl, credentials.accessToken, fetchImpl)).ok) {
    repository.recordAuthStatus(site.id, { status: "valid", source: "token:access", error: "" });
    return { token: credentials.accessToken, headers: {}, source: "token:access" };
  }
  if (credentials.refreshToken) {
    const refreshed = await refreshToken(site.baseUrl, credentials.refreshToken, fetchImpl);
    if (refreshed?.accessToken) {
      await credentialStore.set(`site:${site.id}`, refreshed);
      repository.recordAuthStatus(site.id, { status: "valid", source: "token:refresh", error: "" });
      return { token: refreshed.accessToken, headers: {}, source: "token:refresh" };
    }
  }
  throw loginRequired(site, "sub2api Token 已过期，需要从 Windows 重新提取");
}
```

Implement `captureBrowserSession(site)` as an explicit non-mutex wrapper that calls `getAccess(site)`, rereads the browser state, and returns `{ accessToken, refreshToken }` only for `sub2api` sites currently using `edge-profile`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --disable-warning=ExperimentalWarning --test test/authManager.test.js test/storage.test.js`

Expected: all tests pass.

### Task 2: Capability And Extraction API

**Files:**
- Modify: `test/server.test.js`
- Modify: `src/server.js`
- Modify: `src/routes.js`

- [ ] **Step 1: Write failing API tests**

Cover capability reporting, explicit extraction, secret-bearing `Cache-Control: no-store`, and the absence of tokens from other responses:

```js
const captured = await fetch(`${fixture.baseUrl}/api/sites/${site.id}/capture-browser-session`, { method: "POST" });
assert.equal(captured.status, 200);
assert.equal(captured.headers.get("cache-control"), "no-store");
assert.deepEqual(await captured.json(), { accessToken: "access", refreshToken: "refresh" });
```

- [ ] **Step 2: Run server tests and confirm RED**

Run: `node --disable-warning=ExperimentalWarning --test test/server.test.js`

Expected: missing capability and 404 extraction endpoint.

- [ ] **Step 3: Implement API and response headers**

Return `browserAuthSupported` from `/api/status`, route `POST /api/sites/:id/capture-browser-session` to `authManager.captureBrowserSession(site)`, and preserve response headers for JSON responses:

```js
return {
  status: 200,
  body: await authManager.captureBrowserSession(site),
  headers: { "Cache-Control": "no-store" }
};
```

Update `sendJson(res, payload, status, headers)` and pass `routed.headers` from `createServer`.

- [ ] **Step 4: Run server tests and confirm GREEN**

Run: `node --disable-warning=ExperimentalWarning --test test/server.test.js`

Expected: all server tests pass and extraction is loopback-protected by the existing management authorization.

### Task 3: Encrypted Transfer Support

**Files:**
- Modify: `test/siteTransferService.test.js`
- Modify: `src/siteTransferService.js`
- Modify: `docs/site-transfer-format.md`

- [ ] **Step 1: Write a failing transfer round-trip test**

Add a source site with `sub2api-token`, export it, decrypt only inside the test, import it into a second repository, and assert the destination vault contains:

```js
{
  accessToken: "portable-access",
  refreshToken: "portable-refresh"
}
```

- [ ] **Step 2: Run transfer tests and confirm RED**

Run: `node --disable-warning=ExperimentalWarning --test test/siteTransferService.test.js`

Expected: payload validation rejects `sub2api-token`.

- [ ] **Step 3: Add the credential variant**

Extend the auth-mode set, strict credential validation, export filtering, and `requiresCredentials`:

```js
if (authMode === "sub2api-token") {
  requireExactKeys(value, ["accessToken", "refreshToken"], index);
  return {
    accessToken: requiredString(value.accessToken, `第 ${index + 1} 项 Access Token`),
    refreshToken: optionalString(value.refreshToken)
  };
}
```

Document the new variant without changing the envelope or payload version.

- [ ] **Step 4: Run transfer tests and confirm GREEN**

Run: `node --disable-warning=ExperimentalWarning --test test/siteTransferService.test.js`

Expected: all transfer and fixed-vector tests pass.

### Task 4: Cross-Platform Site Editor

**Files:**
- Modify: `test/ui.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: Write failing UI contract tests**

Require the new option, sensitive inputs, extraction command, capability gate, endpoint usage, and clearing behavior:

```js
for (const id of ["sub2api-token-credentials", "credential-sub2api-access-token", "credential-sub2api-refresh-token", "capture-browser-session"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
}
assert.ok(script.includes("/capture-browser-session"));
assert.match(script, /browserAuthSupported/);
```

- [ ] **Step 2: Run UI tests and confirm RED**

Run: `node --disable-warning=ExperimentalWarning --test test/ui.test.js`

Expected: missing controls and endpoint usage.

- [ ] **Step 3: Implement the editor flow**

Add password inputs for sub2api Access/Refresh Token, include `sub2api-token` in labels and `pendingCredentialBody`, capture the Windows session into the form, and hide Edge-only commands when `state.browserAuthSupported` is false:

```js
async function captureBrowserSession(event) {
  const site = state.editingSite;
  if (!site) throw new Error("请先保存站点再提取登录态");
  const tokens = await withButton(event.currentTarget, () => api(`/api/sites/${site.id}/capture-browser-session`, { method: "POST" }));
  $("#site-auth-mode").value = "sub2api-token";
  $("#credential-sub2api-access-token").value = tokens.accessToken;
  $("#credential-sub2api-refresh-token").value = tokens.refreshToken;
  updateCredentialFields();
}
```

Clear both fields when opening, saving, or closing the dialog.

- [ ] **Step 4: Run UI tests and confirm GREEN**

Run: `node --disable-warning=ExperimentalWarning --test test/ui.test.js test/server.test.js`

Expected: all UI and API contract tests pass.

### Task 5: Full Verification, Deployment, And Publication

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update documentation**

Document Windows extraction, Linux manual Token entry, token expiration behavior, and encrypted transfer. Do not include live server credentials, IP addresses, PEM paths, or Vault Keys.

- [ ] **Step 2: Run complete local verification**

Run: `npm test`

Expected: zero failures, followed by `git diff --check` with no errors.

- [ ] **Step 3: Restart and smoke-test Windows**

Restart the local Node service on `127.0.0.1:5177`, verify `/health`, `/api/status`, and the new editor/API contracts without exposing token values in command output.

- [ ] **Step 4: Deploy Linux with rollback backup**

Create a code and data backup, stage the release, run the full test suite on Linux, atomically replace `/opt/group-price-fetcher`, restart `group-price-fetcher.service`, and verify Caddy-authenticated HTTPS plus `browserAuthSupported=false`.

- [ ] **Step 5: Publish to GitHub**

Run the `publish-to-github` preflight, scan staged content for secrets, commit with `feat: add portable sub2api token auth`, push `main`, and verify the remote branch hash matches local HEAD.
