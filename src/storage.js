import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeBaseUrl } from "./httpClient.js";

const CREDENTIAL_KEY_RE = /token|password|cookie|credential|secret/i;
const AUTH_MODES = new Set(["public", "sub2api-password", "newapi-token", "edge-profile"]);
const SITE_SORTS = new Map([
  ["name", "s.name"],
  ["baseUrl", "s.base_url"],
  ["updatedAt", "s.updated_at"],
  ["nextRunAt", "s.next_run_at"],
  ["authStatus", "s.auth_status"]
]);
const RATE_SORTS = new Map([
  ["rate", "r.effective_rate_multiplier"],
  ["site", "s.name"],
  ["group", "r.group_name"],
  ["platform", "r.platform"],
  ["updatedAt", "r.valid_from"]
]);

export function createRepository({ dbPath = ":memory:", clock = () => new Date() } = {}) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

  function migrate() {
    let version = db.prepare("PRAGMA user_version").get().user_version;

    if (version < 1) db.exec(`
      BEGIN;
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        schedule_minutes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sites (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE,
        provider_id TEXT NOT NULL DEFAULT 'uling-gateway',
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        schedule_minutes INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        auth_status TEXT NOT NULL DEFAULT 'unknown',
        auth_source TEXT NOT NULL DEFAULT '',
        auth_error TEXT NOT NULL DEFAULT '',
        last_auth_at TEXT,
        last_collected_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE site_tags (
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (site_id, tag_id)
      );
      CREATE TABLE collection_runs (
        id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        http_status INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE rate_versions (
        id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        subscription_type TEXT NOT NULL DEFAULT '',
        billing_type TEXT NOT NULL DEFAULT '',
        base_rate_multiplier REAL,
        user_rate_multiplier REAL,
        effective_rate_multiplier REAL NOT NULL,
        peak_enabled INTEGER NOT NULL DEFAULT 0,
        peak_start TEXT NOT NULL DEFAULT '',
        peak_end TEXT NOT NULL DEFAULT '',
        peak_multiplier REAL,
        peak_effective_multiplier REAL,
        description TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT
      );
      CREATE INDEX idx_sites_due ON sites(enabled, next_run_at);
      CREATE INDEX idx_runs_site_started ON collection_runs(site_id, started_at DESC);
      CREATE UNIQUE INDEX idx_rate_current ON rate_versions(site_id, group_id) WHERE valid_to IS NULL;
      CREATE INDEX idx_rate_history ON rate_versions(site_id, group_id, valid_from DESC);
      INSERT INTO settings(key, value) VALUES ('global_schedule_minutes', '60');
      PRAGMA user_version = 1;
      COMMIT;
    `);
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 2) db.exec(`
      BEGIN;
      ALTER TABLE sites ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'edge-profile';
      ALTER TABLE sites ADD COLUMN auth_username TEXT NOT NULL DEFAULT '';
      ALTER TABLE sites ADD COLUMN credential_ref TEXT NOT NULL DEFAULT '';
      PRAGMA user_version = 2;
      COMMIT;
    `);
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 3) db.exec(`
      BEGIN;
      ALTER TABLE rate_versions ADD COLUMN rpm_limit REAL NOT NULL DEFAULT 0;
      ALTER TABLE rate_versions ADD COLUMN is_exclusive INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rate_versions ADD COLUMN daily_limit_usd REAL;
      ALTER TABLE rate_versions ADD COLUMN weekly_limit_usd REAL;
      ALTER TABLE rate_versions ADD COLUMN monthly_limit_usd REAL;
      CREATE TABLE change_events (
        id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES collection_runs(id) ON DELETE SET NULL,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        change_type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        change_percent REAL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_changes_created ON change_events(created_at DESC, id DESC);
      CREATE INDEX idx_changes_site_created ON change_events(site_id, created_at DESC, id DESC);
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  function createCategory(input) {
    rejectCredentials(input);
    const now = iso(clock());
    const name = requiredText(input.name, "分类名称");
    const scheduleMinutes = optionalPositiveInteger(input.scheduleMinutes, "采集频率");
    const result = db.prepare(`
      INSERT INTO categories(name, schedule_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(name, scheduleMinutes, now, now);
    return getCategory(Number(result.lastInsertRowid));
  }

  function updateCategory(id, patch) {
    rejectCredentials(patch);
    const current = requireCategory(id);
    const name = patch.name === undefined ? current.name : requiredText(patch.name, "分类名称");
    const scheduleMinutes = patch.scheduleMinutes === undefined
      ? current.scheduleMinutes
      : optionalPositiveInteger(patch.scheduleMinutes, "采集频率");
    db.prepare("UPDATE categories SET name = ?, schedule_minutes = ?, updated_at = ? WHERE id = ?")
      .run(name, scheduleMinutes, iso(clock()), id);
    return getCategory(id);
  }

  function getCategory(id) {
    const row = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    return row ? mapCategory(row) : null;
  }

  function listCategories() {
    return db.prepare(`
      SELECT c.*, COUNT(s.id) AS site_count
      FROM categories c LEFT JOIN sites s ON s.category_id = c.id
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE
    `).all().map((row) => ({ ...mapCategory(row), siteCount: Number(row.site_count) }));
  }

  function deleteCategory(id) {
    return db.prepare("DELETE FROM categories WHERE id = ?").run(id).changes > 0;
  }

  function listTags() {
    return db.prepare(`
      SELECT t.name, COUNT(st.site_id) AS site_count
      FROM tags t LEFT JOIN site_tags st ON st.tag_id = t.id
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE
    `).all().map((row) => ({ name: row.name, siteCount: Number(row.site_count) }));
  }

  function createSite(input) {
    rejectCredentials(input);
    const now = iso(clock());
    const record = normalizeSiteInput(input);
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = db.prepare(`
        INSERT INTO sites(name, base_url, provider_id, category_id, schedule_minutes, enabled, auth_mode, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.name,
        record.baseUrl,
        record.providerId,
        record.categoryId,
        record.scheduleMinutes,
        record.enabled ? 1 : 0,
        record.authMode,
        now,
        now,
        now
      );
      const id = Number(result.lastInsertRowid);
      replaceSiteTags(id, input.tags ?? []);
      db.exec("COMMIT");
      return getSite(id);
    } catch (error) {
      rollback();
      if (/UNIQUE constraint failed: sites.base_url/.test(error.message)) {
        throw new Error(`站点已存在：${record.baseUrl}`);
      }
      throw error;
    }
  }

  function updateSite(id, patch) {
    rejectCredentials(patch);
    const current = requireSite(id);
    const merged = normalizeSiteInput({ ...current, ...patch });
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`
        UPDATE sites SET name = ?, base_url = ?, provider_id = ?, category_id = ?,
          schedule_minutes = ?, enabled = ?, auth_mode = ?, updated_at = ? WHERE id = ?
      `).run(
        merged.name,
        merged.baseUrl,
        merged.providerId,
        merged.categoryId,
        merged.scheduleMinutes,
        merged.enabled ? 1 : 0,
        merged.authMode,
        iso(clock()),
        id
      );
      if (patch.tags !== undefined) replaceSiteTags(id, patch.tags);
      db.exec("COMMIT");
      return getSite(id);
    } catch (error) {
      rollback();
      if (/UNIQUE constraint failed: sites.base_url/.test(error.message)) {
        throw new Error(`站点已存在：${merged.baseUrl}`);
      }
      throw error;
    }
  }

  function getSite(id) {
    const row = db.prepare(siteSelect("WHERE s.id = ?")).get(id);
    return row ? mapSite(row) : null;
  }

  function listSites(options = {}) {
    const page = positiveInteger(options.page ?? 1, "页码");
    const pageSize = Math.min(200, positiveInteger(options.pageSize ?? 50, "每页数量"));
    const sort = SITE_SORTS.get(options.sortBy ?? "name");
    if (!sort) throw new Error("不支持的站点排序字段");
    const direction = normalizeDirection(options.sortDir);
    const where = [];
    const params = [];
    if (options.query) {
      where.push("(s.name LIKE ? OR s.base_url LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    if (options.categoryId !== undefined && options.categoryId !== null && options.categoryId !== "") {
      where.push("s.category_id = ?");
      params.push(Number(options.categoryId));
    }
    if (options.authStatus) {
      where.push("s.auth_status = ?");
      params.push(options.authStatus);
    }
    if (options.enabled !== undefined) {
      where.push("s.enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.tag) {
      where.push("EXISTS (SELECT 1 FROM site_tags st2 JOIN tags t2 ON t2.id = st2.tag_id WHERE st2.site_id = s.id AND t2.name = ?)");
      params.push(options.tag);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM sites s ${clause}`).get(...params).count);
    const rows = db.prepare(`${siteSelect(clause)} ORDER BY ${sort} ${direction}, s.id ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map(mapSite);
    return { items: rows, total, page, pageSize };
  }

  function deleteSite(id) {
    return db.prepare("DELETE FROM sites WHERE id = ?").run(id).changes > 0;
  }

  function setGlobalSchedule(minutes) {
    const value = positiveInteger(minutes, "全局采集频率");
    db.prepare("INSERT INTO settings(key, value) VALUES ('global_schedule_minutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(value));
    return value;
  }

  function getGlobalSchedule() {
    return Number(db.prepare("SELECT value FROM settings WHERE key = 'global_schedule_minutes'").get()?.value ?? 60);
  }

  function getExternalApiKeyHash() {
    return db.prepare("SELECT value FROM settings WHERE key = 'external_api_key_hash'").get()?.value ?? "";
  }

  function setExternalApiKeyHash(hash) {
    const value = String(hash ?? "");
    if (value && !/^[a-f0-9]{64}$/i.test(value)) throw new Error("API Key 哈希无效");
    db.prepare(`
      INSERT INTO settings(key, value) VALUES ('external_api_key_hash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(value);
  }

  function getEffectiveSchedule(siteId) {
    const row = db.prepare(`
      SELECT s.schedule_minutes AS site_schedule, c.schedule_minutes AS category_schedule
      FROM sites s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = ?
    `).get(siteId);
    if (!row) throw new Error(`站点不存在：${siteId}`);
    return row.site_schedule ?? row.category_schedule ?? getGlobalSchedule();
  }

  function recordAuthStatus(siteId, input) {
    rejectCredentials(input);
    requireSite(siteId);
    const status = requiredText(input.status, "认证状态");
    db.prepare(`
      UPDATE sites SET auth_status = ?, auth_source = ?, auth_error = ?, last_auth_at = ?, updated_at = ? WHERE id = ?
    `).run(status, input.source ?? "", input.error ?? "", iso(clock()), iso(clock()), siteId);
    return getSite(siteId);
  }

  function setSiteAuthConfig(siteId, input) {
    requireSite(siteId);
    const authMode = normalizeAuthMode(input.authMode);
    const credentialRef = String(input.credentialRef ?? "");
    if (credentialRef !== `site:${siteId}`) throw new Error("凭据引用无效");
    db.prepare(`
      UPDATE sites SET auth_mode = ?, auth_username = ?, credential_ref = ?,
        auth_status = 'unknown', auth_source = '', auth_error = '', updated_at = ? WHERE id = ?
    `).run(authMode, maskUsername(input.username), credentialRef, iso(clock()), siteId);
    return getSite(siteId);
  }

  function clearSiteAuthConfig(siteId) {
    requireSite(siteId);
    db.prepare(`
      UPDATE sites SET auth_username = '', credential_ref = '', auth_status = 'unknown',
        auth_source = '', auth_error = '', updated_at = ? WHERE id = ?
    `).run(iso(clock()), siteId);
    return getSite(siteId);
  }

  function startRun(siteId, trigger = "scheduled", startedAt = iso(clock())) {
    requireSite(siteId);
    const result = db.prepare(`
      INSERT INTO collection_runs(site_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)
    `).run(siteId, trigger, startedAt);
    return Number(result.lastInsertRowid);
  }

  function finishRun(runId, input) {
    rejectCredentials(input);
    const finishedAt = input.finishedAt ?? iso(clock());
    const run = db.prepare("SELECT * FROM collection_runs WHERE id = ?").get(runId);
    if (!run) throw new Error(`采集记录不存在：${runId}`);
    const durationMs = input.durationMs ?? Math.max(0, new Date(finishedAt) - new Date(run.started_at));
    db.prepare(`
      UPDATE collection_runs SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, error_code = ?, error_message = ?
      WHERE id = ?
    `).run(
      input.status,
      finishedAt,
      durationMs,
      input.httpStatus ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      runId
    );
    if (input.status === "success") {
      db.prepare("UPDATE sites SET last_collected_at = ?, updated_at = ? WHERE id = ?")
        .run(finishedAt, iso(clock()), run.site_id);
    }
    return mapRun(db.prepare("SELECT * FROM collection_runs WHERE id = ?").get(runId));
  }

  function listRuns({ siteId, limit = 100 } = {}) {
    const safeLimit = Math.min(500, positiveInteger(limit, "记录数量"));
    const rows = siteId
      ? db.prepare("SELECT * FROM collection_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT ?").all(siteId, safeLimit)
      : db.prepare("SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT ?").all(safeLimit);
    return rows.map(mapRun);
  }

  function saveCollection(siteId, result, collectedAt = iso(clock()), runId = null) {
    requireSite(siteId);
    if (!Array.isArray(result?.groups)) throw new Error("采集结果缺少 groups");
    let insertedVersions = 0;
    let changeCount = 0;
    const seen = new Set();
    try {
      db.exec("BEGIN IMMEDIATE");
      const hadBaseline = Boolean(db.prepare("SELECT 1 FROM rate_versions WHERE site_id = ? LIMIT 1").get(siteId));
      for (const group of result.groups) {
        const groupId = String(group.groupId);
        seen.add(groupId);
        const normalized = normalizeRate(group);
        const hash = hashRate(normalized);
        const current = db.prepare(`
          SELECT * FROM rate_versions WHERE site_id = ? AND group_id = ? AND valid_to IS NULL
        `).get(siteId, groupId);
        if (current?.content_hash === hash) continue;
        if (hadBaseline) {
          const changes = current
            ? diffRates(rateFromRow(current), normalized)
            : [{ changeType: "group_added", oldValue: null, newValue: publicRateSnapshot(normalized) }];
          for (const change of changes) {
            insertChange({
              siteId,
              runId,
              groupId,
              groupName: normalized.groupName,
              createdAt: collectedAt,
              ...change
            });
            changeCount += 1;
          }
        }
        if (current) db.prepare("UPDATE rate_versions SET valid_to = ? WHERE id = ?").run(collectedAt, current.id);
        db.prepare(`
          INSERT INTO rate_versions(
            site_id, group_id, group_name, platform, status, subscription_type, billing_type,
            base_rate_multiplier, user_rate_multiplier, effective_rate_multiplier,
            peak_enabled, peak_start, peak_end, peak_multiplier, peak_effective_multiplier,
            description, rpm_limit, is_exclusive, daily_limit_usd, weekly_limit_usd, monthly_limit_usd,
            content_hash, valid_from
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          siteId,
          groupId,
          normalized.groupName,
          normalized.platform,
          normalized.status,
          normalized.subscriptionType,
          normalized.billingType,
          normalized.baseRateMultiplier,
          normalized.userRateMultiplier,
          normalized.effectiveRateMultiplier,
          normalized.peakEnabled ? 1 : 0,
          normalized.peakStart,
          normalized.peakEnd,
          normalized.peakMultiplier,
          normalized.peakEffectiveMultiplier,
          normalized.description,
          normalized.rpmLimit,
          normalized.isExclusive ? 1 : 0,
          normalized.dailyLimitUsd,
          normalized.weeklyLimitUsd,
          normalized.monthlyLimitUsd,
          hash,
          collectedAt
        );
        insertedVersions += 1;
      }
      const currentGroups = db.prepare("SELECT * FROM rate_versions WHERE site_id = ? AND valid_to IS NULL").all(siteId);
      for (const current of currentGroups) {
        if (!seen.has(current.group_id)) {
          db.prepare("UPDATE rate_versions SET valid_to = ? WHERE id = ?").run(collectedAt, current.id);
          if (hadBaseline) {
            insertChange({
              siteId,
              runId,
              groupId: current.group_id,
              groupName: current.group_name,
              changeType: "group_removed",
              oldValue: publicRateSnapshot(rateFromRow(current)),
              newValue: null,
              createdAt: collectedAt
            });
            changeCount += 1;
          }
        }
      }
      db.exec("COMMIT");
      return { insertedVersions, groupCount: result.groups.length, changeCount };
    } catch (error) {
      rollback();
      throw error;
    }
  }

  function insertChange(input) {
    const changePercent = input.changeType === "ratio_changed"
      ? percentageChange(input.oldValue, input.newValue)
      : null;
    const severity = input.changeType === "group_removed"
      ? "critical"
      : input.changeType === "ratio_changed" && Number(input.newValue) > Number(input.oldValue)
        ? "warning"
        : "info";
    db.prepare(`
      INSERT INTO change_events(
        site_id, run_id, group_id, group_name, change_type, old_value, new_value,
        change_percent, severity, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.siteId,
      runIdOrNull(input.runId),
      input.groupId,
      input.groupName,
      input.changeType,
      jsonValue(input.oldValue),
      jsonValue(input.newValue),
      changePercent,
      severity,
      changeMessage(input.changeType, input.groupName, input.oldValue, input.newValue),
      input.createdAt
    );
  }

  function listLatestRates(options = {}) {
    const page = positiveInteger(options.page ?? 1, "页码");
    const pageSize = Math.min(500, positiveInteger(options.pageSize ?? 100, "每页数量"));
    const sort = RATE_SORTS.get(options.sortBy ?? "rate");
    if (!sort) throw new Error("不支持的倍率排序字段");
    const direction = normalizeDirection(options.sortDir ?? "asc");
    const where = ["r.valid_to IS NULL"];
    const params = [];
    if (options.siteId) { where.push("s.id = ?"); params.push(Number(options.siteId)); }
    if (options.categoryId) { where.push("s.category_id = ?"); params.push(Number(options.categoryId)); }
    if (options.platform) { where.push("r.platform = ?"); params.push(options.platform); }
    if (options.status) { where.push("r.status = ?"); params.push(options.status); }
    if (options.authStatus) { where.push("s.auth_status = ?"); params.push(options.authStatus); }
    if (options.tag) {
      where.push("EXISTS (SELECT 1 FROM site_tags st JOIN tags t ON t.id = st.tag_id WHERE st.site_id = s.id AND t.name = ?)");
      params.push(options.tag);
    }
    if (options.query) {
      where.push("(s.name LIKE ? OR r.group_name LIKE ? OR r.platform LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const base = `FROM rate_versions r JOIN sites s ON s.id = r.site_id LEFT JOIN categories c ON c.id = s.category_id ${clause}`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS count ${base}`).get(...params).count);
    const items = db.prepare(`
      SELECT r.*, s.name AS site_name, s.base_url, s.auth_status, c.name AS category_name
      ${base} ORDER BY ${sort} ${direction}, r.id ASC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize).map(mapRate);
    return { items, total, page, pageSize };
  }

  function getRateHistory(siteId, groupId, limit = 200) {
    return db.prepare(`
      SELECT r.*, s.name AS site_name, s.base_url, s.auth_status, c.name AS category_name
      FROM rate_versions r JOIN sites s ON s.id = r.site_id LEFT JOIN categories c ON c.id = s.category_id
      WHERE r.site_id = ? AND r.group_id = ? ORDER BY r.valid_from DESC LIMIT ?
    `).all(siteId, String(groupId), Math.min(1000, positiveInteger(limit, "历史数量"))).map(mapRate);
  }

  function listChanges(options = {}) {
    const page = positiveInteger(options.page ?? 1, "页码");
    const pageSize = Math.min(500, positiveInteger(options.pageSize ?? 100, "每页数量"));
    const where = [];
    const params = [];
    if (options.siteId) { where.push("e.site_id = ?"); params.push(Number(options.siteId)); }
    if (options.changeType) { where.push("e.change_type = ?"); params.push(String(options.changeType)); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const base = `FROM change_events e JOIN sites s ON s.id = e.site_id LEFT JOIN categories c ON c.id = s.category_id ${clause}`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS count ${base}`).get(...params).count);
    const items = db.prepare(`
      SELECT e.*, s.name AS site_name, s.base_url, c.name AS category_name
      ${base} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize).map(mapChange);
    return { items, total, page, pageSize };
  }

  function listDueSites(now = iso(clock()), limit = 200) {
    return db.prepare(`${siteSelect("WHERE s.enabled = 1 AND (s.next_run_at IS NULL OR s.next_run_at <= ?)")} ORDER BY s.next_run_at ASC LIMIT ?`)
      .all(now, Math.min(500, positiveInteger(limit, "到期站点数量"))).map(mapSite);
  }

  function setNextRun(siteId, nextRunAt) {
    requireSite(siteId);
    db.prepare("UPDATE sites SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, iso(clock()), siteId);
  }

  function close() {
    db.close();
  }

  migrate();
  return {
    migrate,
    close,
    createCategory,
    updateCategory,
    getCategory,
    listCategories,
    deleteCategory,
    listTags,
    createSite,
    updateSite,
    getSite,
    listSites,
    deleteSite,
    setGlobalSchedule,
    getGlobalSchedule,
    getExternalApiKeyHash,
    setExternalApiKeyHash,
    getEffectiveSchedule,
    recordAuthStatus,
    setSiteAuthConfig,
    clearSiteAuthConfig,
    startRun,
    finishRun,
    listRuns,
    saveCollection,
    listLatestRates,
    getRateHistory,
    listChanges,
    listDueSites,
    setNextRun
  };

  function replaceSiteTags(siteId, tags) {
    if (!Array.isArray(tags)) throw new Error("标签必须是数组");
    db.prepare("DELETE FROM site_tags WHERE site_id = ?").run(siteId);
    for (const rawTag of [...new Set(tags.map((tag) => requiredText(tag, "标签")))]) {
      db.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(rawTag);
      const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(rawTag);
      db.prepare("INSERT INTO site_tags(site_id, tag_id) VALUES (?, ?)").run(siteId, tag.id);
    }
  }

  function requireSite(id) {
    const site = getSite(id);
    if (!site) throw new Error(`站点不存在：${id}`);
    return site;
  }

  function requireCategory(id) {
    const category = getCategory(id);
    if (!category) throw new Error(`分类不存在：${id}`);
    return category;
  }

  function rollback() {
    try { db.exec("ROLLBACK"); } catch {}
  }
}

function siteSelect(where = "") {
  return `
    SELECT s.*, c.name AS category_name,
      COALESCE(GROUP_CONCAT(t.name, char(31)), '') AS tag_names
    FROM sites s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN site_tags st ON st.site_id = s.id
    LEFT JOIN tags t ON t.id = st.tag_id
    ${where}
    GROUP BY s.id
  `;
}

function normalizeSiteInput(input) {
  const providerId = requiredText(input.providerId ?? "uling-gateway", "Provider");
  return {
    name: requiredText(input.name, "站点名称"),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    providerId,
    categoryId: input.categoryId === null || input.categoryId === undefined || input.categoryId === ""
      ? null
      : Number(input.categoryId),
    scheduleMinutes: optionalPositiveInteger(input.scheduleMinutes, "采集频率"),
    enabled: input.enabled !== false,
    authMode: normalizeAuthMode(input.authMode ?? (providerId === "newapi" ? "public" : "edge-profile"))
  };
}

function normalizeRate(group) {
  const effective = finiteNumber(group.effectiveRateMultiplier, "实际倍率");
  return {
    groupName: requiredText(group.groupName, "分组名称"),
    platform: String(group.platform ?? ""),
    status: String(group.status ?? ""),
    subscriptionType: String(group.subscriptionType ?? ""),
    billingType: String(group.billingType ?? ""),
    baseRateMultiplier: nullableFiniteNumber(group.baseRateMultiplier),
    userRateMultiplier: nullableFiniteNumber(group.userRateMultiplier),
    effectiveRateMultiplier: effective,
    peakEnabled: Boolean(group.peakRate?.enabled),
    peakStart: String(group.peakRate?.start ?? ""),
    peakEnd: String(group.peakRate?.end ?? ""),
    peakMultiplier: nullableFiniteNumber(group.peakRate?.multiplier),
    peakEffectiveMultiplier: nullableFiniteNumber(group.peakRate?.effectiveMultiplier),
    description: String(group.description ?? ""),
    rpmLimit: nullableFiniteNumber(group.rpmLimit) ?? 0,
    isExclusive: Boolean(group.isExclusive ?? group.raw?.is_exclusive),
    dailyLimitUsd: nullableFiniteNumber(group.dailyLimitUsd),
    weeklyLimitUsd: nullableFiniteNumber(group.weeklyLimitUsd),
    monthlyLimitUsd: nullableFiniteNumber(group.monthlyLimitUsd)
  };
}

function hashRate(rate) {
  return createHash("sha256").update(JSON.stringify(rate)).digest("hex");
}

function mapCategory(row) {
  return {
    id: Number(row.id),
    name: row.name,
    scheduleMinutes: row.schedule_minutes === null ? null : Number(row.schedule_minutes),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSite(row) {
  return {
    id: Number(row.id),
    name: row.name,
    baseUrl: row.base_url,
    providerId: row.provider_id,
    categoryId: row.category_id === null ? null : Number(row.category_id),
    categoryName: row.category_name ?? "",
    scheduleMinutes: row.schedule_minutes === null ? null : Number(row.schedule_minutes),
    enabled: Boolean(row.enabled),
    authStatus: row.auth_status,
    authMode: row.auth_mode,
    authUsername: row.auth_username,
    credentialConfigured: Boolean(row.credential_ref),
    authSource: row.auth_source,
    authError: row.auth_error,
    lastAuthAt: row.last_auth_at,
    lastCollectedAt: row.last_collected_at,
    nextRunAt: row.next_run_at,
    tags: row.tag_names ? row.tag_names.split(String.fromCharCode(31)).filter(Boolean).sort() : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row) {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    errorMessage: row.error_message
  };
}

function mapRate(row) {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    siteName: row.site_name,
    baseUrl: row.base_url,
    categoryName: row.category_name ?? "",
    authStatus: row.auth_status,
    groupId: row.group_id,
    groupName: row.group_name,
    platform: row.platform,
    status: row.status,
    subscriptionType: row.subscription_type,
    billingType: row.billing_type,
    baseRateMultiplier: row.base_rate_multiplier,
    userRateMultiplier: row.user_rate_multiplier,
    effectiveRateMultiplier: row.effective_rate_multiplier,
    peakEnabled: Boolean(row.peak_enabled),
    peakStart: row.peak_start,
    peakEnd: row.peak_end,
    peakMultiplier: row.peak_multiplier,
    peakEffectiveMultiplier: row.peak_effective_multiplier,
    description: row.description,
    rpmLimit: row.rpm_limit,
    isExclusive: Boolean(row.is_exclusive),
    dailyLimitUsd: row.daily_limit_usd,
    weeklyLimitUsd: row.weekly_limit_usd,
    monthlyLimitUsd: row.monthly_limit_usd,
    validFrom: row.valid_from,
    validTo: row.valid_to
  };
}

function mapChange(row) {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    runId: row.run_id === null ? null : Number(row.run_id),
    siteName: row.site_name,
    baseUrl: row.base_url,
    categoryName: row.category_name ?? "",
    groupId: row.group_id,
    groupName: row.group_name,
    changeType: row.change_type,
    oldValue: parseJsonValue(row.old_value),
    newValue: parseJsonValue(row.new_value),
    changePercent: row.change_percent,
    severity: row.severity,
    message: row.message,
    createdAt: row.created_at
  };
}

function rateFromRow(row) {
  return {
    groupName: row.group_name,
    platform: row.platform,
    status: row.status,
    subscriptionType: row.subscription_type,
    billingType: row.billing_type,
    baseRateMultiplier: row.base_rate_multiplier,
    userRateMultiplier: row.user_rate_multiplier,
    effectiveRateMultiplier: row.effective_rate_multiplier,
    peakEnabled: Boolean(row.peak_enabled),
    peakStart: row.peak_start,
    peakEnd: row.peak_end,
    peakMultiplier: row.peak_multiplier,
    peakEffectiveMultiplier: row.peak_effective_multiplier,
    description: row.description,
    rpmLimit: row.rpm_limit,
    isExclusive: Boolean(row.is_exclusive),
    dailyLimitUsd: row.daily_limit_usd,
    weeklyLimitUsd: row.weekly_limit_usd,
    monthlyLimitUsd: row.monthly_limit_usd
  };
}

function diffRates(oldRate, newRate) {
  const fields = [
    ["groupName", "group_name_changed"],
    ["platform", "platform_changed"],
    ["effectiveRateMultiplier", "ratio_changed"],
    ["description", "desc_changed"],
    ["status", "status_changed"],
    ["subscriptionType", "subscription_type_changed"],
    ["billingType", "billing_type_changed"],
    ["rpmLimit", "rpm_limit_changed"],
    ["isExclusive", "is_exclusive_changed"]
  ];
  const changes = fields
    .filter(([field]) => !sameValue(oldRate[field], newRate[field]))
    .map(([field, changeType]) => ({ changeType, oldValue: oldRate[field], newValue: newRate[field] }));
  const oldLimits = limitsValue(oldRate);
  const newLimits = limitsValue(newRate);
  if (!sameValue(oldLimits, newLimits)) changes.push({ changeType: "limits_changed", oldValue: oldLimits, newValue: newLimits });
  const oldPeak = peakValue(oldRate);
  const newPeak = peakValue(newRate);
  if (!sameValue(oldPeak, newPeak)) changes.push({ changeType: "peak_rule_changed", oldValue: oldPeak, newValue: newPeak });
  return changes;
}

function publicRateSnapshot(rate) {
  return {
    groupName: rate.groupName,
    platform: rate.platform,
    status: rate.status,
    effectiveRateMultiplier: rate.effectiveRateMultiplier,
    description: rate.description
  };
}

function limitsValue(rate) {
  return {
    dailyLimitUsd: rate.dailyLimitUsd,
    weeklyLimitUsd: rate.weeklyLimitUsd,
    monthlyLimitUsd: rate.monthlyLimitUsd
  };
}

function peakValue(rate) {
  if (!rate.peakEnabled) return { enabled: false };
  return {
    enabled: true,
    start: rate.peakStart,
    end: rate.peakEnd,
    multiplier: rate.peakMultiplier,
    effectiveMultiplier: rate.peakEffectiveMultiplier
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function percentageChange(oldValue, newValue) {
  const oldNumber = Number(oldValue);
  const newNumber = Number(newValue);
  if (!Number.isFinite(oldNumber) || !Number.isFinite(newNumber) || oldNumber === 0) return null;
  return Number((((newNumber - oldNumber) / oldNumber) * 100).toFixed(6));
}

function jsonValue(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonValue(value) {
  if (value === null) return null;
  try { return JSON.parse(value); }
  catch { return value; }
}

function runIdOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error("采集记录 ID 无效");
  return number;
}

function changeMessage(type, groupName, oldValue, newValue) {
  if (type === "group_added") return `新增分组 ${groupName}`;
  if (type === "group_removed") return `删除分组 ${groupName}`;
  if (type === "ratio_changed") return `${groupName} 倍率 ${oldValue} -> ${newValue}`;
  return `${groupName} ${type}`;
}

function rejectCredentials(input) {
  for (const key of Object.keys(input ?? {})) {
    if (CREDENTIAL_KEY_RE.test(key)) throw new Error(`禁止把认证凭据字段写入数据库：${key}`);
  }
}

function normalizeAuthMode(value) {
  const mode = String(value ?? "");
  if (!AUTH_MODES.has(mode)) throw new Error(`不支持的认证方式：${mode}`);
  return mode;
}

function maskUsername(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const at = text.indexOf("@");
  if (at > 0) return `${text[0]}***${text.slice(at)}`;
  return text.length <= 2 ? `${text[0]}***` : `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return positiveInteger(value, label);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是有限数字`);
  return number;
}

function nullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value, "倍率");
}

function normalizeDirection(value = "asc") {
  const direction = String(value).toLowerCase();
  if (direction !== "asc" && direction !== "desc") throw new Error("排序方向只能是 asc 或 desc");
  return direction.toUpperCase();
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("时间无效");
  return date.toISOString();
}
