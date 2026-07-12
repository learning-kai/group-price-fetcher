# Group Price Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-local manager for 50+ compatible gateway sites with persistent browser authentication, configurable scheduling, normalized rate history, sorting, filtering, and operational recovery.

**Architecture:** Keep the existing provider as the API collector. Add focused services for local paths, SQLite persistence, persistent Edge authentication, scheduling, and collection orchestration; expose these through the existing localhost HTTP server and replace the one-shot UI with a site-management dashboard. Edge LevelDB scanning remains a validated one-time import fallback only.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, `playwright-core` with installed Microsoft Edge, native HTTP server, HTML/CSS/JavaScript, Node test runner.

---

### Task 1: Local paths and SQLite repository

**Files:**
- Create: `src/appPaths.js`
- Create: `src/storage.js`
- Test: `test/storage.test.js`

- [x] Write failing tests proving paths default below `%LOCALAPPDATA%`, schema migrations are idempotent, site URLs are unique, tags round-trip, schedule precedence is site > category > global, and tokens are never accepted by repository methods.
- [x] Run `node --test test/storage.test.js` and confirm failure because the modules do not exist.
- [x] Implement `resolveAppPaths()`, `createRepository()`, schema versioning, site/category/tag CRUD, run records, auth status, and change-only rate versions.
- [x] Run `node --test test/storage.test.js` and confirm all storage tests pass.

### Task 2: Persistent browser authentication

**Files:**
- Create: `src/authManager.js`
- Modify: `src/edgeAuth.js`
- Test: `test/authManager.test.js`

- [x] Write failing tests for access-token validation, refresh-and-writeback, per-profile mutual exclusion, explicit interactive login, `401` expiry, and one-time Edge import validation.
- [x] Run `node --test test/authManager.test.js` and confirm failure because `createAuthManager()` is missing.
- [x] Implement an injected browser adapter interface plus the Playwright persistent Edge adapter. Keep secrets only in browser storage and memory; persist only status metadata.
- [x] Add an import function that scans existing Edge data, validates `/auth/me`, then writes the tokens into the dedicated profile.
- [x] Run the auth tests and then the full suite.

### Task 3: Provider probe and resilient collection queue

**Files:**
- Modify: `src/providers/ulingGateway.js`
- Create: `src/taskQueue.js`
- Create: `src/collector.js`
- Test: `test/collector.test.js`

- [x] Write failing tests for compatibility probing, maximum concurrency, timeout isolation, `401` refresh-once behavior, `403` permission classification, `429 Retry-After`, `5xx` backoff, and partial batch success.
- [x] Run `node --test test/collector.test.js` and confirm expected failures.
- [x] Implement `probeCompatibility()`, a bounded queue, error classification, retry policy, and `createCollector()` that writes run records and rate versions transactionally.
- [x] Run collector tests and the full suite.

### Task 4: Hierarchical scheduler

**Files:**
- Create: `src/scheduler.js`
- Test: `test/scheduler.test.js`

- [x] Write failing tests for global/category/site interval precedence, deterministic jitter injection, disabled sites, restart recovery, and no overlapping run for one site.
- [x] Run `node --test test/scheduler.test.js` and confirm expected failures.
- [x] Implement a scheduler that reads due sites from SQLite, submits them to the bounded queue, and calculates the next run after every outcome.
- [x] Run scheduler tests and the full suite.

### Task 5: Management HTTP API

**Files:**
- Create: `src/routes.js`
- Modify: `src/server.js`
- Test: `test/server.test.js`

- [x] Write failing integration tests for site/category/tag CRUD, pagination, validated sort fields, combined filters, manual refresh, login/import actions, history, run errors, and response secret scanning.
- [x] Run `node --test test/server.test.js` and confirm expected failures.
- [x] Extract routing from `server.js`, wire repository/auth/collector/scheduler dependencies, retain legacy `/api/price-groups`, and keep the server bound to `127.0.0.1` by default.
- [x] Run server tests and the full suite.

### Task 6: Site-management dashboard

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `test/ui.test.js`

- [x] Write failing static-contract tests for site creation, category/tag filters, platform/group/auth filters, sortable rate columns, pagination, manual refresh, login actions, history view, loading/empty/error states, and absence of token inputs.
- [x] Run `node --test test/ui.test.js` and confirm expected failures.
- [x] Implement a dense operational dashboard using the management API, stable table dimensions, responsive controls, accessible buttons, and no nested cards or explanatory marketing content.
- [x] Run UI tests and full tests, then verify desktop and mobile layouts in a real browser.

### Task 7: Windows operation, documentation, and acceptance

**Files:**
- Create: `scripts/install-startup.ps1`
- Create: `scripts/uninstall-startup.ps1`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/acceptance.test.js`

- [x] Write failing acceptance tests that simulate 60 sites and prove bounded concurrency, partial failure, change-only history, restart recovery, and secret-free persisted data/log output.
- [x] Add `playwright-core`, startup scripts using Windows Task Scheduler, graceful shutdown, configuration documentation, data locations, backup guidance, and migration caveats.
- [x] Run `npm test`, start the application, check `/health`, exercise CRUD and a manual mocked collection, inspect SQLite contents for secrets, and capture desktop/mobile browser evidence.
- [x] Confirm every requirement in the approved task DAG has authoritative evidence. This workspace has no Git repository, so commit steps are intentionally omitted rather than initializing Git without permission.
