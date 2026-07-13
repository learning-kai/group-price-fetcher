# Site Rate Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a positive per-site conversion factor and use converted effective rates consistently while preserving upstream values.

**Architecture:** SQLite v6 stores `sites.rate_conversion_factor`. Raw collected rates remain unchanged; repository read models calculate the converted `effectiveRateMultiplier` and expose the raw value separately.

**Tech Stack:** Node.js ESM, `node:sqlite`, Node test runner, vanilla browser JavaScript.

---

### Task 1: Persist and Calculate Site Conversion

**Files:**
- Modify: `src/storage.js`
- Modify: `test/storage.test.js`

- [ ] Add failing tests proving a factor `0.1` converts raw `0.8` to `0.08`, adjusted sorting is used, site create/update round-trips the factor, invalid non-positive factors fail, history is converted, and raw stored history/change counts stay unchanged.
- [ ] Run `node --disable-warning=ExperimentalWarning --test test/storage.test.js` and verify RED.
- [ ] Add schema v6:

```sql
ALTER TABLE sites ADD COLUMN rate_conversion_factor REAL NOT NULL DEFAULT 1 CHECK(rate_conversion_factor > 0);
PRAGMA user_version = 6;
```

- [ ] Add `rateConversionFactor` to create/update/map site paths. Join the factor into current/history/export rate queries. Map `sourceEffectiveRateMultiplier` from the stored value and calculate `effectiveRateMultiplier` with stable decimal rounding. Sort `rate` by `r.effective_rate_multiplier * s.rate_conversion_factor`.
- [ ] Run storage tests and commit `feat: add site rate conversion`.

### Task 2: Preserve Conversion in Exports and External API

**Files:**
- Modify: `src/exporters.js`
- Modify: `src/routes.js`
- Modify: `test/exportService.test.js`
- Modify: `test/server.test.js`

- [ ] Add failing assertions that JSON and external API rates contain `sourceEffectiveRateMultiplier`, `rateConversionFactor`, and converted `effectiveRateMultiplier`; external site data exposes the factor; CSV contains `source_effective_rate_multiplier` and `rate_conversion_factor` columns.
- [ ] Run `node --disable-warning=ExperimentalWarning --test test/exportService.test.js test/server.test.js` and verify RED.
- [ ] Extend `ratesToCsv()` and `externalSite()` with the confirmed fields. Do not change change-event values or collection storage.
- [ ] Run focused tests and commit `feat: export converted site rates`.

### Task 3: Edit Conversion Factor in the Site Form

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/ui.test.js`

- [ ] Add failing UI contract tests for `#site-rate-conversion-factor`, default `1`, positive numeric constraints, dialog population, and save payload.
- [ ] Run `node --disable-warning=ExperimentalWarning --test test/ui.test.js` and verify RED.
- [ ] Add a `type="number" min="0.000001" step="any"` field labelled “倍率换算系数”. Populate `site?.rateConversionFactor ?? 1` and send `Number(value)` in create/update requests.
- [ ] Run UI tests and commit `feat: edit site rate conversion factor`.

### Task 4: Verify and Update Local Service

- [ ] Run `node --check public\app.js` and `npm test`.
- [ ] Run an isolated HTTP smoke test that edits a site to `0.1`, verifies raw `0.8` becomes `0.08` in management API, external API, JSON and CSV, and verifies raw stored SQLite remains `0.8`.
- [ ] Back up the formal DB to `prices.db.pre-v6-<timestamp>.bak`, restart only the PID on 5177, then verify schema v6, unchanged site/rate/change counts, health, UI field, and empty stderr.
