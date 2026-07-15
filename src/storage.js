import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeBaseUrl } from "./httpClient.js";

const CREDENTIAL_KEY_RE = /token|password|cookie|credential|secret/i;
const AUTH_MODES = new Set(["public", "sub2api-password", "sub2api-token", "newapi-token", "edge-profile"]);
const SITE_SORTS = new Map([
  ["name", "s.name"],
  ["baseUrl", "s.base_url"],
  ["updatedAt", "s.updated_at"],
  ["nextRunAt", "s.next_run_at"],
  ["authStatus", "s.auth_status"]
]);
const RATE_SORTS = new Map([
  ["rate", "r.effective_rate_multiplier * s.rate_conversion_factor"],
  ["site", "s.name"],
  ["group", "r.group_name"],
  ["platform", "r.platform"],
  ["updatedAt", "r.valid_from"]
]);
const MODEL_FAMILIES = new Set(["gpt", "grok", "other"]);

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
        provider_id TEXT NOT NULL DEFAULT 'sub2api',
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
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 4) db.exec(`
      BEGIN;
      UPDATE sites SET provider_id = 'sub2api' WHERE provider_id = 'uling-gateway';
      PRAGMA user_version = 4;
      COMMIT;
    `);
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 5) db.exec(`
      BEGIN;
      CREATE TABLE hidden_rate_groups (
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (site_id, group_id)
      );
      PRAGMA user_version = 5;
      COMMIT;
    `);
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 6) db.exec(`
      BEGIN;
      ALTER TABLE sites ADD COLUMN rate_conversion_factor REAL NOT NULL DEFAULT 1 CHECK(rate_conversion_factor > 0);
      PRAGMA user_version = 6;
      COMMIT;
    `);
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 7) {
      const columns = new Set(db.prepare("PRAGMA table_info(sites)").all().map((column) => column.name));
      db.exec("BEGIN");
      try {
        if (!columns.has("current_rate_multiplier")) db.exec("ALTER TABLE sites ADD COLUMN current_rate_multiplier REAL");
        if (!columns.has("current_rate_ambiguous")) db.exec("ALTER TABLE sites ADD COLUMN current_rate_ambiguous INTEGER NOT NULL DEFAULT 0");
        if (!columns.has("current_rate_count")) db.exec("ALTER TABLE sites ADD COLUMN current_rate_count INTEGER NOT NULL DEFAULT 0");
        db.exec("PRAGMA user_version = 7; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 8) {
      const columns = new Set(db.prepare("PRAGMA table_info(sites)").all().map((column) => column.name));
      db.exec("BEGIN");
      try {
        if (!columns.has("balance_usd")) db.exec("ALTER TABLE sites ADD COLUMN balance_usd REAL");
        if (!columns.has("balance_status")) db.exec("ALTER TABLE sites ADD COLUMN balance_status TEXT NOT NULL DEFAULT 'unknown'");
        if (!columns.has("balance_source")) db.exec("ALTER TABLE sites ADD COLUMN balance_source TEXT NOT NULL DEFAULT ''");
        if (!columns.has("balance_updated_at")) db.exec("ALTER TABLE sites ADD COLUMN balance_updated_at TEXT");
        if (!columns.has("balance_error")) db.exec("ALTER TABLE sites ADD COLUMN balance_error TEXT NOT NULL DEFAULT ''");
        db.exec("PRAGMA user_version = 8; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 9) {
      const columns = new Set(db.prepare("PRAGMA table_info(sites)").all().map((column) => column.name));
      db.exec("BEGIN");
      try {
        if (!columns.has("balance_threshold_usd")) db.exec("ALTER TABLE sites ADD COLUMN balance_threshold_usd REAL");
        db.exec(`
          CREATE TABLE IF NOT EXISTS notification_channels (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            subscriptions TEXT NOT NULL DEFAULT '[]',
            event_types TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS notification_logs (
            id INTEGER PRIMARY KEY,
            channel_id INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
            channel_name TEXT NOT NULL DEFAULT '',
            channel_type TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            error_code TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON notification_logs(created_at DESC, id DESC);
          CREATE INDEX IF NOT EXISTS idx_notification_logs_channel_created ON notification_logs(channel_id, created_at DESC, id DESC);
          CREATE TABLE IF NOT EXISTS notification_cooldowns (
            channel_id INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
            cooldown_key TEXT NOT NULL,
            last_sent_at TEXT NOT NULL,
            PRIMARY KEY (channel_id, cooldown_key)
          );
          PRAGMA user_version = 9;
          COMMIT;
        `);
      } catch (error) {
        rollback();
        throw error;
      }
    }
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 10) {
      const columns = new Set(db.prepare("PRAGMA table_info(sites)").all().map((column) => column.name));
      db.exec("BEGIN");
      try {
        if (!columns.has("gpt_current_rate_multiplier")) db.exec("ALTER TABLE sites ADD COLUMN gpt_current_rate_multiplier REAL");
        if (!columns.has("gpt_current_rate_ambiguous")) db.exec("ALTER TABLE sites ADD COLUMN gpt_current_rate_ambiguous INTEGER NOT NULL DEFAULT 0");
        if (!columns.has("gpt_current_rate_count")) db.exec("ALTER TABLE sites ADD COLUMN gpt_current_rate_count INTEGER NOT NULL DEFAULT 0");
        if (!columns.has("gpt_current_rate_key_name")) db.exec("ALTER TABLE sites ADD COLUMN gpt_current_rate_key_name TEXT NOT NULL DEFAULT ''");
        if (!columns.has("grok_current_rate_multiplier")) db.exec("ALTER TABLE sites ADD COLUMN grok_current_rate_multiplier REAL");
        if (!columns.has("grok_current_rate_ambiguous")) db.exec("ALTER TABLE sites ADD COLUMN grok_current_rate_ambiguous INTEGER NOT NULL DEFAULT 0");
        if (!columns.has("grok_current_rate_count")) db.exec("ALTER TABLE sites ADD COLUMN grok_current_rate_count INTEGER NOT NULL DEFAULT 0");
        if (!columns.has("grok_current_rate_group_name")) db.exec("ALTER TABLE sites ADD COLUMN grok_current_rate_group_name TEXT NOT NULL DEFAULT ''");
        // Backfill GPT identity from legacy site-level current rate so old rows keep working.
        db.exec(`
          UPDATE sites
          SET gpt_current_rate_multiplier = current_rate_multiplier,
              gpt_current_rate_ambiguous = current_rate_ambiguous,
              gpt_current_rate_count = current_rate_count,
              gpt_current_rate_key_name = CASE
                WHEN current_rate_multiplier IS NOT NULL THEN '1111'
                ELSE ''
              END
          WHERE gpt_current_rate_multiplier IS NULL
            AND current_rate_multiplier IS NOT NULL
        `);
        // Backfill Grok identity from the exact upstream group name/id "grok".
        db.exec(`
          UPDATE sites
          SET grok_current_rate_multiplier = (
                SELECT r.effective_rate_multiplier
                FROM rate_versions r
                WHERE r.site_id = sites.id
                  AND r.valid_to IS NULL
                  AND (trim(r.group_name) = 'grok' OR trim(r.group_id) = 'grok')
                ORDER BY r.id DESC
                LIMIT 1
              ),
              grok_current_rate_ambiguous = 0,
              grok_current_rate_count = CASE WHEN EXISTS (
                SELECT 1 FROM rate_versions r
                WHERE r.site_id = sites.id
                  AND r.valid_to IS NULL
                  AND (trim(r.group_name) = 'grok' OR trim(r.group_id) = 'grok')
              ) THEN 1 ELSE 0 END,
              grok_current_rate_group_name = CASE WHEN EXISTS (
                SELECT 1 FROM rate_versions r
                WHERE r.site_id = sites.id
                  AND r.valid_to IS NULL
                  AND (trim(r.group_name) = 'grok' OR trim(r.group_id) = 'grok')
              ) THEN 'grok' ELSE '' END
          WHERE grok_current_rate_multiplier IS NULL
        `);
        db.exec("PRAGMA user_version = 10; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    version = db.prepare("PRAGMA user_version").get().user_version;
    if (version < 11) {
      const columns = new Set(db.prepare("PRAGMA table_info(sites)").all().map((column) => column.name));
      db.exec("BEGIN");
      try {
        if (!columns.has("grok_current_rate_key_name")) {
          db.exec("ALTER TABLE sites ADD COLUMN grok_current_rate_key_name TEXT NOT NULL DEFAULT ''");
        }
        // Grok identity is key-name based ("grok"), not group-name based.
        // Clear any previous group-name backfill so stale values do not mislead until re-collection.
        db.exec(`
          UPDATE sites
          SET grok_current_rate_multiplier = NULL,
              grok_current_rate_ambiguous = 0,
              grok_current_rate_count = 0,
              grok_current_rate_group_name = '',
              grok_current_rate_key_name = ''
        `);
        db.exec("PRAGMA user_version = 11; COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
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
        INSERT INTO sites(
          name, base_url, provider_id, category_id, schedule_minutes, enabled,
          auth_mode, rate_conversion_factor, balance_threshold_usd, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.name,
        record.baseUrl,
        record.providerId,
        record.categoryId,
        record.scheduleMinutes,
        record.enabled ? 1 : 0,
        record.authMode,
        record.rateConversionFactor,
        record.balanceThresholdUsd,
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
          schedule_minutes = ?, enabled = ?, auth_mode = ?, rate_conversion_factor = ?,
          balance_threshold_usd = ?, updated_at = ? WHERE id = ?
      `).run(
        merged.name,
        merged.baseUrl,
        merged.providerId,
        merged.categoryId,
        merged.scheduleMinutes,
        merged.enabled ? 1 : 0,
        merged.authMode,
        merged.rateConversionFactor,
        merged.balanceThresholdUsd,
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

  function getSiteByBaseUrl(baseUrl) {
    const row = db.prepare(siteSelect("WHERE s.base_url = ?")).get(normalizeBaseUrl(baseUrl));
    return row ? mapSite(row) : null;
  }

  function exportTransferSites() {
    return db.prepare(`${siteSelect()} ORDER BY s.name COLLATE NOCASE, s.id ASC`).all().map(mapSite);
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

  function createNotificationChannel(input) {
    const now = iso(clock());
    const record = normalizeNotificationChannel(input);
    const result = db.prepare(`
      INSERT INTO notification_channels(name, type, enabled, subscriptions, event_types, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.name, record.type, record.enabled ? 1 : 0, JSON.stringify(record.subscriptions), JSON.stringify(record.eventTypes), now, now);
    return getNotificationChannel(Number(result.lastInsertRowid));
  }

  function updateNotificationChannel(id, patch) {
    const current = getNotificationChannel(id);
    if (!current) throw new Error(`通知渠道不存在：${id}`);
    const record = normalizeNotificationChannel({ ...current, ...patch });
    db.prepare(`
      UPDATE notification_channels SET name = ?, type = ?, enabled = ?, subscriptions = ?, event_types = ?, updated_at = ?
      WHERE id = ?
    `).run(record.name, record.type, record.enabled ? 1 : 0, JSON.stringify(record.subscriptions), JSON.stringify(record.eventTypes), iso(clock()), id);
    return getNotificationChannel(id);
  }

  function getNotificationChannel(id) {
    const row = db.prepare("SELECT * FROM notification_channels WHERE id = ?").get(id);
    return row ? mapNotificationChannel(row) : null;
  }

  function listNotificationChannels() {
    return db.prepare("SELECT * FROM notification_channels ORDER BY name COLLATE NOCASE, id").all().map(mapNotificationChannel);
  }

  function deleteNotificationChannel(id) {
    return db.prepare("DELETE FROM notification_channels WHERE id = ?").run(id).changes > 0;
  }

  function createNotificationLog(input) {
    const channel = input.channelId ? getNotificationChannel(input.channelId) : null;
    const result = db.prepare(`
      INSERT INTO notification_logs(
        channel_id, channel_name, channel_type, event_type, status, message,
        error_code, error_message, attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      channel?.id ?? null,
      channel?.name ?? String(input.channelName ?? ""),
      channel?.type ?? String(input.channelType ?? ""),
      String(input.eventType ?? ""),
      requiredText(input.status, "通知状态"),
      String(input.message ?? "").slice(0, 2000),
      String(input.errorCode ?? "").slice(0, 100),
      String(input.errorMessage ?? "").slice(0, 1000),
      positiveInteger(input.attempts ?? 1, "通知尝试次数"),
      iso(input.createdAt ?? clock())
    );
    return mapNotificationLog(db.prepare("SELECT * FROM notification_logs WHERE id = ?").get(Number(result.lastInsertRowid)));
  }

  function listNotificationLogs(options = {}) {
    const page = positiveInteger(options.page ?? 1, "页码");
    const pageSize = Math.min(200, positiveInteger(options.pageSize ?? 50, "每页数量"));
    const where = [];
    const params = [];
    if (options.channelId !== undefined && options.channelId !== null && options.channelId !== "") {
      where.push("channel_id = ?");
      params.push(positiveInteger(options.channelId, "通知渠道 ID"));
    }
    if (options.status) { where.push("status = ?"); params.push(String(options.status)); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(db.prepare(`SELECT COUNT(*) count FROM notification_logs ${clause}`).get(...params).count);
    const items = db.prepare(`SELECT * FROM notification_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize).map(mapNotificationLog);
    return { items, total, page, pageSize };
  }

  function getNotificationCooldown(channelId, cooldownKey) {
    return db.prepare("SELECT last_sent_at FROM notification_cooldowns WHERE channel_id = ? AND cooldown_key = ?")
      .get(positiveInteger(channelId, "通知渠道 ID"), requiredText(cooldownKey, "冷却键"))?.last_sent_at ?? null;
  }

  function setNotificationCooldown(channelId, cooldownKey, sentAt = clock()) {
    db.prepare(`
      INSERT INTO notification_cooldowns(channel_id, cooldown_key, last_sent_at) VALUES (?, ?, ?)
      ON CONFLICT(channel_id, cooldown_key) DO UPDATE SET last_sent_at = excluded.last_sent_at
    `).run(positiveInteger(channelId, "通知渠道 ID"), requiredText(cooldownKey, "冷却键"), iso(sentAt));
    return iso(sentAt);
  }

  function getNotificationPolicy() {
    const defaults = {
      minRatioChangePercent: 0,
      balanceCooldownHours: 24,
      failureCooldownMinutes: 60,
      retryAttempts: 3
    };
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'notification_policy'").get()?.value;
    if (!raw) return defaults;
    try {
      const stored = JSON.parse(raw);
      const legacyCooldown = Number(stored.cooldownMinutes);
      return {
        minRatioChangePercent: stored.minRatioChangePercent ?? defaults.minRatioChangePercent,
        balanceCooldownHours: stored.balanceCooldownHours
          ?? (Number.isFinite(legacyCooldown) ? legacyCooldown / 60 : defaults.balanceCooldownHours),
        failureCooldownMinutes: stored.failureCooldownMinutes
          ?? (Number.isFinite(legacyCooldown) ? legacyCooldown : defaults.failureCooldownMinutes),
        retryAttempts: stored.retryAttempts ?? defaults.retryAttempts
      };
    } catch {
      return defaults;
    }
  }

  function setNotificationPolicy(input) {
    const current = getNotificationPolicy();
    const legacyCooldown = input.cooldownMinutes === undefined ? null : Number(input.cooldownMinutes);
    const minRatioChangePercent = Number(input.minRatioChangePercent ?? current.minRatioChangePercent);
    const balanceCooldownHours = Number(input.balanceCooldownHours
      ?? (legacyCooldown === null ? current.balanceCooldownHours : legacyCooldown / 60));
    const failureCooldownMinutes = Number(input.failureCooldownMinutes
      ?? (legacyCooldown === null ? current.failureCooldownMinutes : legacyCooldown));
    const retryAttempts = Number(input.retryAttempts ?? current.retryAttempts);
    if (!Number.isFinite(minRatioChangePercent) || minRatioChangePercent < 0) throw new Error("最小倍率变化百分比必须是非负有限数字");
    if (!Number.isFinite(balanceCooldownHours) || balanceCooldownHours < 0) throw new Error("余额通知冷却小时必须是非负有限数字");
    if (!Number.isFinite(failureCooldownMinutes) || failureCooldownMinutes < 0) throw new Error("失败通知冷却分钟必须是非负有限数字");
    if (!Number.isInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 3) throw new Error("通知重试次数必须是 1 到 3 的整数");
    const value = { minRatioChangePercent, balanceCooldownHours, failureCooldownMinutes, retryAttempts };
    db.prepare("INSERT INTO settings(key, value) VALUES ('notification_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(value));
    return value;
  }

  function getDynamicRatioSettings() {
    const defaults = dynamicRatioDefaults();
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'dynamic_ratio_settings'").get()?.value;
    if (!raw) return defaults;
    try {
      const stored = JSON.parse(raw);
      if (stored?.version === 2 && Array.isArray(stored.policies)) {
        const byFamily = new Map(stored.policies.map((policy) => [policy?.family, policy]));
        return {
          version: 2,
          policies: defaults.policies.map((fallback) => normalizeDynamicRatioPolicy(byFamily.get(fallback.family) ?? fallback, fallback))
        };
      }
      return {
        version: 2,
        policies: [
          normalizeDynamicRatioPolicy({ ...defaults.policies[0], ...stored, family: "gpt" }, defaults.policies[0]),
          defaults.policies[1]
        ]
      };
    } catch {
      return defaults;
    }
  }

  function setDynamicRatioSettings(input) {
    if (input?.version !== 2 || !Array.isArray(input.policies)) throw new Error("动态倍率策略格式无效");
    const defaults = dynamicRatioDefaults();
    const byFamily = new Map();
    for (const policy of input.policies) {
      const family = normalizeModelFamily(policy?.family);
      if (family === "other" || byFamily.has(family)) throw new Error("动态倍率模型族无效");
      const fallback = defaults.policies.find((item) => item.family === family);
      byFamily.set(family, normalizeDynamicRatioPolicy(policy, fallback));
    }
    if (!byFamily.has("gpt") || !byFamily.has("grok")) throw new Error("动态倍率策略必须包含 GPT 和 Grok");
    const value = { version: 2, policies: [byFamily.get("gpt"), byFamily.get("grok")] };
    db.prepare("INSERT INTO settings(key, value) VALUES ('dynamic_ratio_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(value));
    return value;
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
    const changes = [];
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
          const rateChanges = current
            ? diffRates(rateFromRow(current), normalized)
            : [{ changeType: "group_added", oldValue: null, newValue: publicRateSnapshot(normalized) }];
          for (const change of rateChanges) {
            changes.push(insertChange({
              siteId,
              runId,
              groupId,
              groupName: normalized.groupName,
              createdAt: collectedAt,
              ...change
            }));
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
            changes.push(insertChange({
              siteId,
              runId,
              groupId: current.group_id,
              groupName: current.group_name,
              changeType: "group_removed",
              oldValue: publicRateSnapshot(rateFromRow(current)),
              newValue: null,
              createdAt: collectedAt
            }));
            changeCount += 1;
          }
        }
      }
      const currentRate = nullableFiniteNumber(result.summary?.currentRateMultiplier);
      const currentRateAmbiguous = Boolean(result.summary?.currentRateAmbiguous);
      const currentRateCount = Number.isInteger(Number(result.summary?.currentRateCount))
        ? Math.max(0, Number(result.summary.currentRateCount))
        : 0;
      const familyCurrent = normalizeFamilyCurrentRates(result.summary);
      const account = normalizeAccount(result.account, collectedAt);
      db.prepare(`
        UPDATE sites
        SET current_rate_multiplier = ?, current_rate_ambiguous = ?, current_rate_count = ?,
          gpt_current_rate_multiplier = ?, gpt_current_rate_ambiguous = ?, gpt_current_rate_count = ?, gpt_current_rate_key_name = ?,
          grok_current_rate_multiplier = ?, grok_current_rate_ambiguous = ?, grok_current_rate_count = ?, grok_current_rate_key_name = ?, grok_current_rate_group_name = ?,
          balance_usd = CASE WHEN ? = 'known' THEN ? ELSE balance_usd END,
          balance_updated_at = CASE WHEN ? = 'known' THEN ? ELSE balance_updated_at END,
          balance_status = ?, balance_source = ?, balance_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        currentRate,
        currentRateAmbiguous ? 1 : 0,
        currentRateCount,
        familyCurrent.gpt.currentRateMultiplier,
        familyCurrent.gpt.currentRateAmbiguous ? 1 : 0,
        familyCurrent.gpt.currentRateCount,
        familyCurrent.gpt.currentRateKeyName,
        familyCurrent.grok.currentRateMultiplier,
        familyCurrent.grok.currentRateAmbiguous ? 1 : 0,
        familyCurrent.grok.currentRateCount,
        familyCurrent.grok.currentRateKeyName,
        familyCurrent.grok.currentRateGroupName,
        account.status,
        account.balanceUsd,
        account.status,
        account.fetchedAt,
        account.status,
        account.source,
        account.error,
        iso(clock()),
        siteId
      );
      db.exec("COMMIT");
      return { insertedVersions, groupCount: result.groups.length, changeCount, changes };
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
    const result = db.prepare(`
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
    return mapChange(db.prepare(`
      SELECT e.*, s.name AS site_name, s.base_url, c.name AS category_name
      FROM change_events e JOIN sites s ON s.id = e.site_id
      LEFT JOIN categories c ON c.id = s.category_id WHERE e.id = ?
    `).get(Number(result.lastInsertRowid)));
  }

  function hideRateGroup(siteId, groupId) {
    const id = positiveInteger(siteId, "站点 ID");
    requireSite(id);
    const group = requiredText(groupId, "分组 ID");
    const current = db.prepare(`
      SELECT 1 FROM rate_versions
      WHERE site_id = ? AND group_id = ? AND valid_to IS NULL
    `).get(id, group);
    if (!current) return null;
    db.prepare(`
      INSERT INTO hidden_rate_groups(site_id, group_id, hidden_at)
      VALUES (?, ?, ?)
      ON CONFLICT(site_id, group_id) DO NOTHING
    `).run(id, group, iso(clock()));
    return { siteId: id, groupId: group, hidden: true };
  }

  function restoreRateGroup(siteId, groupId) {
    const id = positiveInteger(siteId, "站点 ID");
    requireSite(id);
    const group = requiredText(groupId, "分组 ID");
    db.prepare("DELETE FROM hidden_rate_groups WHERE site_id = ? AND group_id = ?").run(id, group);
    return { siteId: id, groupId: group, hidden: false };
  }

  function listLatestRates(options = {}) {
    const page = positiveInteger(options.page ?? 1, "页码");
    const pageSize = Math.min(500, positiveInteger(options.pageSize ?? 100, "每页数量"));
    const sort = RATE_SORTS.get(options.sortBy ?? "rate");
    if (!sort) throw new Error("不支持的倍率排序字段");
    const direction = normalizeDirection(options.sortDir ?? "asc");
    const visibility = normalizeRateVisibility(options.visibility ?? "all");
    const where = ["r.valid_to IS NULL"];
    const params = [];
    if (visibility === "visible") {
      where.push("NOT EXISTS (SELECT 1 FROM hidden_rate_groups h WHERE h.site_id = r.site_id AND h.group_id = r.group_id)");
    }
    if (visibility === "hidden") {
      where.push("EXISTS (SELECT 1 FROM hidden_rate_groups h WHERE h.site_id = r.site_id AND h.group_id = r.group_id)");
    }
    if (options.siteId) { where.push("s.id = ?"); params.push(Number(options.siteId)); }
    if (options.categoryId) { where.push("s.category_id = ?"); params.push(Number(options.categoryId)); }
    if (options.platform) { where.push("r.platform = ?"); params.push(options.platform); }
    if (options.modelFamily) {
      const family = normalizeModelFamily(options.modelFamily);
      where.push(modelFamilySql("r")[family]);
    }
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
      SELECT r.*, s.name AS site_name, s.base_url, s.auth_status,
        s.rate_conversion_factor, s.current_rate_multiplier, s.current_rate_ambiguous,
        s.current_rate_count,
        s.gpt_current_rate_multiplier, s.gpt_current_rate_ambiguous, s.gpt_current_rate_count, s.gpt_current_rate_key_name,
        s.grok_current_rate_multiplier, s.grok_current_rate_ambiguous, s.grok_current_rate_count, s.grok_current_rate_key_name, s.grok_current_rate_group_name,
        c.name AS category_name,
        EXISTS (
          SELECT 1 FROM hidden_rate_groups h
          WHERE h.site_id = r.site_id AND h.group_id = r.group_id
        ) AS is_hidden
      ${base} ORDER BY ${sort} ${direction}, r.id ASC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize).map(mapRate);
    return { items, total, page, pageSize };
  }

  function getRateHistory(siteId, groupId, limit = 200) {
    return db.prepare(`
      SELECT r.*, s.name AS site_name, s.base_url, s.auth_status,
        s.rate_conversion_factor, s.current_rate_multiplier, s.current_rate_ambiguous,
        s.current_rate_count,
        s.gpt_current_rate_multiplier, s.gpt_current_rate_ambiguous, s.gpt_current_rate_count, s.gpt_current_rate_key_name,
        s.grok_current_rate_multiplier, s.grok_current_rate_ambiguous, s.grok_current_rate_count, s.grok_current_rate_key_name, s.grok_current_rate_group_name,
        c.name AS category_name
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

  function exportPublicData(exportedAt = iso(clock())) {
    const sites = db.prepare(siteSelect()).all().map(mapSite).map((site) => ({
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      providerId: site.providerId,
      categoryId: site.categoryId,
      categoryName: site.categoryName,
      tags: site.tags,
      enabled: site.enabled,
      rateConversionFactor: site.rateConversionFactor,
      authStatus: site.authStatus,
      lastCollectedAt: site.lastCollectedAt,
      updatedAt: site.updatedAt
    }));
    const rates = db.prepare(`
      SELECT r.*, s.name AS site_name, s.base_url, s.auth_status,
        s.rate_conversion_factor, s.current_rate_multiplier, s.current_rate_ambiguous,
        s.current_rate_count, c.name AS category_name
      FROM rate_versions r JOIN sites s ON s.id = r.site_id
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE r.valid_to IS NULL
      ORDER BY s.name COLLATE NOCASE, r.group_name COLLATE NOCASE, r.id
    `).all().map(mapRate);
    const changes = db.prepare(`
      SELECT e.*, s.name AS site_name, s.base_url, c.name AS category_name
      FROM change_events e JOIN sites s ON s.id = e.site_id
      LEFT JOIN categories c ON c.id = s.category_id
      ORDER BY e.created_at DESC, e.id DESC
    `).all().map(mapChange);
    return { formatVersion: 1, exportedAt: iso(exportedAt), sites, rates, changes };
  }

  function checkpoint() {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
    getSiteByBaseUrl,
    exportTransferSites,
    listSites,
    deleteSite,
    setGlobalSchedule,
    getGlobalSchedule,
    createNotificationChannel,
    updateNotificationChannel,
    getNotificationChannel,
    listNotificationChannels,
    deleteNotificationChannel,
    createNotificationLog,
    listNotificationLogs,
    getNotificationCooldown,
    setNotificationCooldown,
    getNotificationPolicy,
    setNotificationPolicy,
    getDynamicRatioSettings,
    setDynamicRatioSettings,

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
    hideRateGroup,
    restoreRateGroup,
    listLatestRates,
    getRateHistory,
    listChanges,
    listDueSites,
    setNextRun,
    exportPublicData,
    checkpoint
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
  const providerId = requiredText(input.providerId ?? "sub2api", "Provider");
  return {
    name: requiredText(input.name, "站点名称"),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    providerId,
    categoryId: input.categoryId === null || input.categoryId === undefined || input.categoryId === ""
      ? null
      : Number(input.categoryId),
    scheduleMinutes: optionalPositiveInteger(input.scheduleMinutes, "采集频率"),
    enabled: input.enabled !== false,
    authMode: normalizeAuthMode(input.authMode ?? (providerId === "newapi" ? "public" : "edge-profile")),
    rateConversionFactor: positiveFiniteNumber(input.rateConversionFactor ?? 1, "倍率换算系数"),
    balanceThresholdUsd: optionalNonNegativeFiniteNumber(input.balanceThresholdUsd, "余额阈值")
  };
}

function normalizeNotificationChannel(input) {
  const subscriptions = normalizePositiveIntegerArray(input.subscriptions ?? [], "通知订阅");
  const eventTypes = normalizeStringArray(input.eventTypes ?? [], "通知事件类型");
  return {
    name: requiredText(input.name, "通知渠道名称"),
    type: requiredText(input.type, "通知渠道类型"),
    enabled: input.enabled !== false,
    subscriptions,
    eventTypes
  };
}

function normalizeAccount(account, fallbackTimestamp) {
  const allowed = new Set(["known", "unavailable", "unknown"]);
  const status = allowed.has(account?.status) ? account.status : "unknown";
  const balanceUsd = status === "known" ? nullableFiniteNumber(account?.balanceUsd) : null;
  return {
    status: status === "known" && balanceUsd === null ? "unavailable" : status,
    balanceUsd,
    source: String(account?.source ?? "").slice(0, 100),
    error: String(account?.error ?? "").slice(0, 300),
    fetchedAt: account?.fetchedAt || fallbackTimestamp
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
  const sourceCurrentRateMultiplier = nullableFiniteNumber(row.current_rate_multiplier);
  const rateConversionFactor = Number(row.rate_conversion_factor ?? 1);
  return {
    id: Number(row.id),
    name: row.name,
    baseUrl: row.base_url,
    providerId: row.provider_id,
    categoryId: row.category_id === null ? null : Number(row.category_id),
    categoryName: row.category_name ?? "",
    scheduleMinutes: row.schedule_minutes === null ? null : Number(row.schedule_minutes),
    rateConversionFactor,
    sourceCurrentRateMultiplier,
    currentRateMultiplier: sourceCurrentRateMultiplier === null
      ? null
      : convertRate(sourceCurrentRateMultiplier, rateConversionFactor),
    currentRateAmbiguous: Boolean(row.current_rate_ambiguous),
    currentRateCount: Number(row.current_rate_count ?? 0),
    balanceUsd: nullableFiniteNumber(row.balance_usd),
    balanceStatus: row.balance_status ?? "unknown",
    balanceSource: row.balance_source ?? "",
    balanceUpdatedAt: row.balance_updated_at ?? null,
    balanceError: row.balance_error ?? "",
    balanceThresholdUsd: nullableFiniteNumber(row.balance_threshold_usd),
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

function mapNotificationChannel(row) {
  return {
    id: Number(row.id),
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    subscriptions: parseJsonArray(row.subscriptions),
    eventTypes: parseJsonArray(row.event_types),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapNotificationLog(row) {
  return {
    id: Number(row.id),
    channelId: row.channel_id === null ? null : Number(row.channel_id),
    channelName: row.channel_name,
    channelType: row.channel_type,
    eventType: row.event_type,
    status: row.status,
    message: row.message,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempts: Number(row.attempts),
    createdAt: row.created_at
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

function dynamicRatioDefaults() {
  return {
    version: 2,
    policies: [
      { family: "gpt", enabled: false, group: "default", serviceMultiplier: 1.2, minimum: 0.01, maximum: 10, changeThreshold: 0.05 },
      { family: "grok", enabled: false, group: "grok", serviceMultiplier: 1, minimum: 0.001, maximum: 10, changeThreshold: 0.001 }
    ]
  };
}

function normalizeDynamicRatioPolicy(input, fallback) {
  const family = normalizeModelFamily(input?.family ?? fallback.family);
  if (family === "other") throw new Error("动态倍率模型族无效");
  const group = requiredText(input?.group ?? fallback.group, "目标分组");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(group)) throw new Error("目标分组格式无效");
  const serviceMultiplier = positiveFiniteNumber(input?.serviceMultiplier ?? fallback.serviceMultiplier, "服务倍率");
  const minimum = positiveFiniteNumber(input?.minimum ?? fallback.minimum, "倍率下限");
  const maximum = positiveFiniteNumber(input?.maximum ?? fallback.maximum, "倍率上限");
  const changeThreshold = finiteNumber(input?.changeThreshold ?? fallback.changeThreshold, "变化阈值");
  if (changeThreshold < 0 || changeThreshold > 1) throw new Error("变化阈值必须在 0 到 1 之间");
  if (minimum > maximum) throw new Error("倍率上下限无效");
  return { family, enabled: Boolean(input?.enabled), group, serviceMultiplier, minimum, maximum, changeThreshold };
}

function normalizeModelFamily(value) {
  const family = String(value ?? "").toLowerCase();
  if (!MODEL_FAMILIES.has(family)) throw new Error("模型族无效");
  return family;
}

function classifyModelFamily(input) {
  const platform = String(input.platform ?? "").toLowerCase();
  const text = `${input.groupId ?? input.group_id ?? ""} ${input.groupName ?? input.group_name ?? ""}`.toLowerCase();
  if (platform === "video" || /(?:视频|video)/i.test(text)) return "other";
  if (["grok", "xai", "x.ai"].includes(platform) || /grok|gork|x\.ai|\bxai\b/i.test(text)) return "grok";
  if (["openai", "newapi"].includes(platform) || /gpt|openai/i.test(text)) return "gpt";
  return "other";
}

function normalizeFamilyCurrentRates(summary = {}) {
  const byFamily = summary?.currentRatesByFamily ?? {};
  const legacy = {
    currentRateMultiplier: nullableFiniteNumber(summary?.currentRateMultiplier),
    currentRateAmbiguous: Boolean(summary?.currentRateAmbiguous),
    currentRateCount: Number.isInteger(Number(summary?.currentRateCount))
      ? Math.max(0, Number(summary.currentRateCount))
      : 0,
    currentRateKeyName: summary?.currentRateKeyName ? String(summary.currentRateKeyName) : "",
    currentRateGroupName: summary?.currentRateGroupName ? String(summary.currentRateGroupName) : ""
  };
  const gpt = byFamily.gpt ?? {};
  const grok = byFamily.grok ?? {};
  return {
    gpt: {
      currentRateMultiplier: nullableFiniteNumber(gpt.currentRateMultiplier ?? legacy.currentRateMultiplier),
      currentRateAmbiguous: Boolean(gpt.currentRateAmbiguous ?? (byFamily.gpt ? false : legacy.currentRateAmbiguous)),
      currentRateCount: Number.isInteger(Number(gpt.currentRateCount))
        ? Math.max(0, Number(gpt.currentRateCount))
        : (byFamily.gpt ? 0 : legacy.currentRateCount),
      currentRateKeyName: String(gpt.currentRateKeyName ?? legacy.currentRateKeyName ?? "").trim()
    },
    grok: {
      currentRateMultiplier: nullableFiniteNumber(grok.currentRateMultiplier),
      currentRateAmbiguous: Boolean(grok.currentRateAmbiguous),
      currentRateCount: Number.isInteger(Number(grok.currentRateCount))
        ? Math.max(0, Number(grok.currentRateCount))
        : 0,
      currentRateKeyName: (() => {
        const named = String(grok.currentRateKeyName ?? "").trim();
        if (named) return named;
        return nullableFiniteNumber(grok.currentRateMultiplier) === null ? "" : "grok";
      })(),
      currentRateGroupName: String(grok.currentRateGroupName ?? "").trim()
    }
  };
}

function resolveFamilyCurrentRate(row, modelFamily) {
  if (modelFamily === "grok") {
    const source = nullableFiniteNumber(row.grok_current_rate_multiplier);
    if (source !== null || Number(row.grok_current_rate_count ?? 0) > 0 || Boolean(row.grok_current_rate_ambiguous)) {
      return {
        sourceCurrentRateMultiplier: source,
        currentRateAmbiguous: Boolean(row.grok_current_rate_ambiguous),
        currentRateCount: Number(row.grok_current_rate_count ?? 0),
        currentRateKeyName: String(row.grok_current_rate_key_name || "grok") || "grok",
        currentRateGroupName: String(row.grok_current_rate_group_name || "") || null
      };
    }
    return {
      sourceCurrentRateMultiplier: null,
      currentRateAmbiguous: false,
      currentRateCount: 0,
      currentRateKeyName: null,
      currentRateGroupName: null
    };
  }

  // GPT and other families use the GPT pricing identity (key 1111), falling back to legacy site current rate.
  const gptSource = nullableFiniteNumber(row.gpt_current_rate_multiplier);
  if (gptSource !== null || Number(row.gpt_current_rate_count ?? 0) > 0 || Boolean(row.gpt_current_rate_ambiguous)) {
    return {
      sourceCurrentRateMultiplier: gptSource,
      currentRateAmbiguous: Boolean(row.gpt_current_rate_ambiguous),
      currentRateCount: Number(row.gpt_current_rate_count ?? 0),
      currentRateKeyName: String(row.gpt_current_rate_key_name || "1111") || "1111",
      currentRateGroupName: null
    };
  }
  return {
    sourceCurrentRateMultiplier: nullableFiniteNumber(row.current_rate_multiplier),
    currentRateAmbiguous: Boolean(row.current_rate_ambiguous),
    currentRateCount: Number(row.current_rate_count ?? 0),
    currentRateKeyName: null,
    currentRateGroupName: null
  };
}

function modelFamilySql(alias = "r") {
  const platform = `lower(coalesce(${alias}.platform, ''))`;
  const text = `lower(coalesce(${alias}.group_id, '') || ' ' || coalesce(${alias}.group_name, ''))`;
  const video = `(${platform} = 'video' OR ${text} LIKE '%video%' OR ${text} LIKE '%视频%')`;
  const grok = `(NOT ${video} AND (${platform} IN ('grok','xai','x.ai') OR ${text} LIKE '%grok%' OR ${text} LIKE '%gork%' OR ${text} LIKE '%x.ai%' OR ${text} LIKE '%xai%'))`;
  const gpt = `(NOT ${grok} AND (${platform} IN ('openai','newapi') OR ${text} LIKE '%gpt%' OR ${text} LIKE '%openai%'))`;
  return { gpt, grok, other: `(NOT ${grok} AND NOT ${gpt})` };
}

function mapRate(row) {
  const sourceEffectiveRateMultiplier = Number(row.effective_rate_multiplier);
  const rateConversionFactor = Number(row.rate_conversion_factor ?? 1);
  const modelFamily = classifyModelFamily(row);
  const familyCurrent = resolveFamilyCurrentRate(row, modelFamily);
  const sourceSiteCurrentRateMultiplier = familyCurrent.sourceCurrentRateMultiplier;
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
    modelFamily,
    status: row.status,
    subscriptionType: row.subscription_type,
    billingType: row.billing_type,
    baseRateMultiplier: row.base_rate_multiplier,
    userRateMultiplier: row.user_rate_multiplier,
    sourceEffectiveRateMultiplier,
    rateConversionFactor,
    effectiveRateMultiplier: convertRate(sourceEffectiveRateMultiplier, rateConversionFactor),
    sourceSiteCurrentRateMultiplier,
    siteCurrentRateMultiplier: sourceSiteCurrentRateMultiplier === null
      ? null
      : convertRate(sourceSiteCurrentRateMultiplier, rateConversionFactor),
    siteCurrentRateAmbiguous: familyCurrent.currentRateAmbiguous,
    siteCurrentRateCount: familyCurrent.currentRateCount,
    siteCurrentRateKeyName: familyCurrent.currentRateKeyName,
    siteCurrentRateGroupName: familyCurrent.currentRateGroupName,
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
    hidden: Boolean(row.is_hidden),
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

function optionalNonNegativeFiniteNumber(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label}必须是非负有限数字`);
  return number;
}

function normalizePositiveIntegerArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return [...new Set(value.map((item) => positiveInteger(item, label)))];
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return [...new Set(value.map((item) => requiredText(item, label)))];
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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


function positiveFiniteNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

function convertRate(value, factor) {
  return Number((value * factor).toPrecision(15));
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

function normalizeRateVisibility(value = "all") {
  const visibility = String(value);
  if (!["all", "visible", "hidden"].includes(visibility)) throw new Error("不支持的倍率可见性");
  return visibility;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("时间无效");
  return date.toISOString();
}
