# Hidden Rate Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistently hide individual `(site_id, group_id)` rows on the latest-rates page and restore them from an “已隐藏” filter.

**Architecture:** Add a schema-v5 preference table independent of rate history. The management API defaults to visible rows, while exports and the external API continue to use all rows.

**Tech Stack:** Node.js ESM, `node:sqlite`, Node test runner, vanilla browser JavaScript.

---

### Task 1: Persist Hidden Group Preferences

**Files:**
- Modify: `src/storage.js`
- Modify: `test/storage.test.js`

- [ ] Write a failing storage test that creates two groups, hides one, and asserts:

```js
assert.deepEqual(repo.listLatestRates({ visibility: "visible" }).items.map((item) => item.groupId), ["group-2"]);
assert.deepEqual(repo.listLatestRates({ visibility: "hidden" }).items.map((item) => item.groupId), ["group-1"]);
assert.equal(repo.listLatestRates({ visibility: "all" }).total, 2);
repo.restoreRateGroup(site.id, "group-1");
assert.equal(repo.listLatestRates({ visibility: "visible" }).total, 2);
```

- [ ] Run `node --disable-warning=ExperimentalWarning --test test/storage.test.js` and verify RED.
- [ ] Add schema v5:

```sql
CREATE TABLE hidden_rate_groups (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (site_id, group_id)
);
PRAGMA user_version = 5;
```

- [ ] Add `hideRateGroup`, `restoreRateGroup`, and `visibility: all|visible|hidden` filtering. `mapRate` exposes `hidden: Boolean(row.is_hidden)`. Keep `exportPublicData()` unchanged.
- [ ] Verify storage tests pass and commit `feat: persist hidden rate groups`.

### Task 2: Add Local Management API

**Files:**
- Modify: `src/routes.js`
- Modify: `test/server.test.js`

- [ ] Add failing tests for:

```text
PUT    /api/sites/:siteId/groups/:groupId/hidden
DELETE /api/sites/:siteId/groups/:groupId/hidden
GET    /api/rates?visibility=visible|hidden
```

The tests must prove the default management list excludes hidden rows, the hidden list returns them, restore is idempotent, remote clients receive 403, and `/api/external/v1/rates` still returns all rows.

- [ ] Run `node --disable-warning=ExperimentalWarning --test test/server.test.js` and verify RED.
- [ ] Add the two routes inside the existing site route and pass `visibility` through `rateQuery`. Management defaults to `visible`; external routes force `all`; invalid values return 400.
- [ ] Verify server tests pass and commit `feat: expose hidden rate group controls`.

### Task 3: Add Hide and Restore Controls

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/ui.test.js`

- [ ] Add failing UI contract tests for `#rate-visibility`, `visibility` query usage, `/groups/` plus `/hidden`, and both `data-action="hide"` and `data-action="restore"`.
- [ ] Run `node --disable-warning=ExperimentalWarning --test test/ui.test.js` and verify RED.
- [ ] Add this filter using the existing filter-bar style:

```html
<label><span>显示</span><select id="rate-visibility"><option value="visible">正常显示</option><option value="hidden">已隐藏</option></select></label>
```

- [ ] Include `visibility` in `loadRates()`. Render “隐藏” for visible rows and “恢复” for hidden rows. Extend `handleRateAction()` to call PUT/DELETE, reset `state.rates.page = 1`, reload rates, and show a toast. Keep “历史” available in both modes.
- [ ] Verify UI tests pass and commit `feat: add rate group visibility controls`.

### Task 4: Verify and Update the Local Service

**Files:**
- Verify only unless a test exposes a scoped defect.

- [ ] Run `node --check public\app.js` and `npm test`.
- [ ] Back up the formal SQLite database to `prices.db.pre-v5-<timestamp>.bak`, preserving the pre-migration byte hash.
- [ ] Restart only the PID listening on 5177 from the main workspace.
- [ ] Verify schema v5, unchanged site/rate/change counts, `/api/rates` defaults to visible, hide/restore works on a temporary test group in an isolated database, exports still include hidden rows, and stderr is empty.
