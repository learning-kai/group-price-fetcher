# Authentication, NewAPI, Changes and External API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted account/password login, NewAPI collection, explicit recent-change events, and a stable read-only API without storing plaintext secrets in SQLite.

**Architecture:** Keep the existing Provider and collector boundaries. Add a Windows DPAPI credential store selected by each site's `authMode`, preserve the Edge profile fallback, and write rate versions plus change events in one SQLite transaction. Expose management endpoints under `/api` and stable consumer endpoints under `/api/external/v1`.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, Windows PowerShell DPAPI, `playwright-core`, Node test runner.

---

### Task 1: Persist Authentication Metadata and Encrypted Credentials

**Files:**
- Create: `src/credentialStore.js`
- Modify: `src/appPaths.js`
- Modify: `src/storage.js`
- Test: `test/credentialStore.test.js`
- Test: `test/storage.test.js`

- [ ] Write a failing test for a credential store with `set/get/delete/has` and for repository site fields `authMode`, `authUsername`, and `credentialConfigured`.
- [ ] Run `node --test test/credentialStore.test.js test/storage.test.js` and verify the missing APIs fail.
- [ ] Implement a DPAPI adapter with an injectable process runner so tests use an in-memory fake and Windows production uses CurrentUser-scoped encryption.
- [ ] Add an idempotent SQLite v2 migration. Store only `auth_mode`, masked/non-secret username, and `credential_ref`; continue rejecting password/token fields.
- [ ] Run the focused tests and verify they pass.

Credential interface:

```js
const store = createCredentialStore({ vaultPath, protector });
await store.set("site:1", { email, password });
await store.get("site:1");
await store.delete("site:1");
```

### Task 2: Split Authentication by Site Mode

**Files:**
- Modify: `src/authManager.js`
- Modify: `src/server.js`
- Test: `test/authManager.test.js`

- [ ] Write failing tests for `public`, `password`, `newapi-token`, and `edge-profile` access modes.
- [ ] Verify password mode logs in with `POST /api/v1/auth/login`, caches tokens in memory, refreshes once, and never records credentials in repository status.
- [ ] Implement `configureCredentials`, `clearCredentials`, and mode-specific `getAccess`.
- [ ] Keep interactive Edge login/import behavior working for existing sites.
- [ ] Run `node --test test/authManager.test.js` and verify all authentication paths pass.

Access result contract:

```js
{ token: "", headers: {}, source: "public" }
{ token: "access", headers: {}, source: "password:login" }
{ token: "system-token", headers: { "New-Api-User": "123" }, source: "newapi:token" }
```

### Task 3: Add sub2api and NewAPI Providers

**Files:**
- Create: `src/providers/sub2api.js`
- Create: `src/providers/newApi.js`
- Modify: `src/providerRegistry.js`
- Modify: `src/collector.js`
- Test: `test/sub2api.test.js`
- Test: `test/newApi.test.js`
- Test: `test/collector.test.js`

- [ ] Write failing provider tests using captured response shapes from `upstream-ratio-watch`.
- [ ] Implement sub2api collection from `/api/v1/groups/available` and `/api/v1/groups/rates`.
- [ ] Implement NewAPI public collection from `/api/user/groups`; when credentials exist, prefer `/api/user/self/groups` and fall back to authenticated `/api/user/groups`.
- [ ] Pass `auth.headers` through the collector rather than assuming Bearer-only authentication.
- [ ] Run all provider and collector tests.

### Task 4: Record Explicit Change Events Atomically

**Files:**
- Modify: `src/storage.js`
- Test: `test/storage.test.js`

- [ ] Write failing tests for baseline suppression, group add/remove, ratio, description, status, subscription, billing, and peak-rule changes.
- [ ] Add `change_events` in migration v2 with indexes by site and time.
- [ ] Diff the prior current rate against normalized incoming groups inside `saveCollection`.
- [ ] Write rate versions and events in the same transaction and return `changeCount`.
- [ ] Add paginated `listChanges` and site-filtered queries.
- [ ] Run storage tests and verify unchanged collections create neither versions nor events.

### Task 5: Add Management and Stable External APIs

**Files:**
- Create: `src/apiKeyAuth.js`
- Modify: `src/routes.js`
- Modify: `src/server.js`
- Test: `test/server.test.js`

- [ ] Write failing tests for credential configuration endpoints, recent-change endpoints, external v1 pagination, and API-key enforcement on non-loopback requests.
- [ ] Add `PUT/DELETE /api/sites/:id/credentials` and ensure responses contain metadata only.
- [ ] Add `GET /api/changes` and `GET /api/sites/:id/changes`.
- [ ] Add `/api/external/v1/sites`, `/rates`, `/changes`, and per-site history routes with a stable `{ apiVersion, data, pagination }` envelope.
- [ ] Hash configured API keys with SHA-256; compare hashes with `timingSafeEqual`; never store or return the raw key.
- [ ] Run server tests.

### Task 6: Add Functional UI Controls

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css` only where existing controls need a selector
- Test: `test/ui.test.js`

- [ ] Write DOM/static contract tests for provider/auth selectors, credential fields, and the recent-change view.
- [ ] Add site authentication controls that conditionally send credentials to the dedicated credential endpoint, never the site record endpoint.
- [ ] Add a recent-change table using `/api/changes` and a per-site change action.
- [ ] Run `node --test test/ui.test.js`.
- [ ] Do not run screenshot, responsive, visual-regression, or layout tests.

### Task 7: Regression and Security Verification

**Files:**
- Modify: `README.md`

- [ ] Document supported providers, authentication modes, API routes, API-key behavior, and DPAPI recovery limitations.
- [ ] Run `npm test`.
- [ ] Inspect the real SQLite schema and source for plaintext `password`, `access_token`, or `refresh_token` persistence.
- [ ] Start the service on a free local port and verify health, management changes, and external v1 responses without modifying existing real site records.
- [ ] Confirm no layout testing was performed.
