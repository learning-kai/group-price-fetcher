import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAppPaths } from "../src/appPaths.js";
import { createRepository } from "../src/storage.js";

test("app data defaults below LOCALAPPDATA instead of the workspace", () => {
  const paths = resolveAppPaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" });
  assert.equal(paths.rootDir, path.win32.join("C:\\Users\\tester\\AppData\\Local", "GroupPriceFetcher"));
  assert.equal(paths.profileDir, path.win32.join(paths.rootDir, "profiles"));
  assert.equal(paths.dbPath, path.win32.join(paths.rootDir, "data", "prices.db"));
  assert.equal(paths.credentialVaultPath, path.win32.join(paths.rootDir, "data", "credentials.vault"));
});

test("repository migrations are idempotent and site configuration round-trips", async () => {
  const fixture = await createFixture();
  try {
    fixture.repo.migrate();
    fixture.repo.migrate();
    fixture.repo.setGlobalSchedule(60);
    const category = fixture.repo.createCategory({ name: "稳定站", scheduleMinutes: 30 });
    const site = fixture.repo.createSite({
      name: "示例站",
      baseUrl: "https://example.com/",
      categoryId: category.id,
      scheduleMinutes: 10,
      tags: ["Claude", "重点"]
    });

    assert.equal(site.baseUrl, "https://example.com");
    assert.deepEqual(fixture.repo.getSite(site.id).tags, ["Claude", "重点"]);
    assert.equal(fixture.repo.getEffectiveSchedule(site.id), 10);

    fixture.repo.updateSite(site.id, { scheduleMinutes: null });
    assert.equal(fixture.repo.getEffectiveSchedule(site.id), 30);

    fixture.repo.updateCategory(category.id, { scheduleMinutes: null });
    assert.equal(fixture.repo.getEffectiveSchedule(site.id), 60);
    assert.throws(
      () => fixture.repo.createSite({ name: "重复", baseUrl: "https://example.com" }),
      /已存在/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("v4 through v6 migrations preserve legacy data and add site conversion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-v4-migration-"));
  const dbPath = path.join(dir, "prices.db");
  let repo = createRepository({ dbPath });
  try {
    const site = repo.createSite({
      name: "旧站",
      baseUrl: "https://legacy.example.com",
      providerId: "sub2api",
      authMode: "edge-profile",
      tags: ["保留"]
    });
    repo.close();
    repo = null;

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE sites SET provider_id = 'uling-gateway' WHERE id = ?").run(site.id);
    if (raw.prepare("PRAGMA table_info(sites)").all().some((column) => column.name === "rate_conversion_factor")) {
      raw.exec("ALTER TABLE sites DROP COLUMN rate_conversion_factor");
    }
    raw.exec("DROP TABLE hidden_rate_groups; PRAGMA user_version = 3");
    raw.close();

    repo = createRepository({ dbPath });
    const migrated = repo.getSite(site.id);
    assert.equal(migrated.providerId, "sub2api");
    assert.equal(migrated.baseUrl, "https://legacy.example.com");
    assert.equal(migrated.authMode, "edge-profile");
    assert.deepEqual(migrated.tags, ["保留"]);
    repo.close();
    repo = null;

    const verification = new DatabaseSync(dbPath);
    try {
      assert.equal(verification.prepare("PRAGMA user_version").get().user_version, 6);
      assert.equal(
        verification.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'hidden_rate_groups'").get().count,
        1
      );
      const conversion = verification.prepare("SELECT rate_conversion_factor FROM sites WHERE id = ?").get(site.id);
      assert.equal(conversion.rate_conversion_factor, 1);
    } finally {
      verification.close();
    }
  } finally {
    repo?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("site conversion adjusts rate reads and sorting without rewriting collected history", async () => {
  const fixture = await createFixture();
  try {
    const convertedSite = fixture.repo.createSite({
      name: "十倍余额站",
      baseUrl: "https://converted.example.com",
      rateConversionFactor: 0.1
    });
    const regularSite = fixture.repo.createSite({
      name: "普通站",
      baseUrl: "https://regular.example.com"
    });
    fixture.repo.saveCollection(convertedSite.id, sampleCollection(0.8), "2026-07-13T00:00:00.000Z");
    fixture.repo.saveCollection(regularSite.id, sampleCollection(0.2), "2026-07-13T00:00:00.000Z");

    assert.equal(fixture.repo.getSite(convertedSite.id).rateConversionFactor, 0.1);
    assert.equal(fixture.repo.getSite(regularSite.id).rateConversionFactor, 1);
    const rates = fixture.repo.listLatestRates({ sortBy: "rate", sortDir: "asc" }).items;
    assert.deepEqual(rates.map((rate) => rate.siteId), [convertedSite.id, regularSite.id]);
    assert.deepEqual({
      source: rates[0].sourceEffectiveRateMultiplier,
      factor: rates[0].rateConversionFactor,
      effective: rates[0].effectiveRateMultiplier
    }, { source: 0.8, factor: 0.1, effective: 0.08 });
    assert.equal(fixture.repo.getRateHistory(convertedSite.id, "group-1")[0].effectiveRateMultiplier, 0.08);

    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT effective_rate_multiplier FROM rate_versions WHERE site_id = ?").get(convertedSite.id).effective_rate_multiplier, 0.8);
    raw.close();
    assert.equal(fixture.repo.listChanges({ siteId: convertedSite.id }).total, 0);

    fixture.repo.updateSite(convertedSite.id, { rateConversionFactor: 0.25 });
    const updated = fixture.repo.listLatestRates({ siteId: convertedSite.id }).items[0];
    assert.equal(updated.sourceEffectiveRateMultiplier, 0.8);
    assert.equal(updated.effectiveRateMultiplier, 0.2);
    assert.equal(fixture.repo.listChanges({ siteId: convertedSite.id }).total, 0);

    const exported = fixture.repo.exportPublicData("2026-07-13T03:00:00.000Z");
    assert.equal(exported.sites.find((site) => site.id === convertedSite.id).rateConversionFactor, 0.25);
    const exportedRate = exported.rates.find((rate) => rate.siteId === convertedSite.id);
    assert.equal(exportedRate.sourceEffectiveRateMultiplier, 0.8);
    assert.equal(exportedRate.rateConversionFactor, 0.25);
    assert.equal(exportedRate.effectiveRateMultiplier, 0.2);

    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => fixture.repo.updateSite(convertedSite.id, { rateConversionFactor: value }),
        /倍率换算系数/
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("hidden rate groups persist independently from collection data", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({ name: "隐藏站", baseUrl: "https://hidden.example.com" });
    fixture.repo.saveCollection(site.id, collectionWithGroups([
      detailedGroup("group-1", { groupName: "隐藏分组", rate: 0.2 }),
      detailedGroup("group-2", { groupName: "保留分组", rate: 0.4 })
    ]), "2026-07-13T00:00:00.000Z");

    assert.equal(fixture.repo.hideRateGroup(site.id, "missing"), null);
    assert.deepEqual(fixture.repo.hideRateGroup(site.id, "group-1"), {
      siteId: site.id,
      groupId: "group-1",
      hidden: true
    });
    assert.deepEqual(fixture.repo.hideRateGroup(site.id, "group-1"), {
      siteId: site.id,
      groupId: "group-1",
      hidden: true
    });
    assert.deepEqual(
      fixture.repo.listLatestRates({ visibility: "visible", sortBy: "group" }).items.map((item) => item.groupId),
      ["group-2"]
    );
    assert.deepEqual(
      fixture.repo.listLatestRates({ visibility: "hidden" }).items.map((item) => [item.groupId, item.hidden]),
      [["group-1", true]]
    );
    assert.equal(fixture.repo.listLatestRates({ visibility: "all" }).total, 2);
    assert.equal(fixture.repo.listLatestRates().total, 2);
    assert.throws(() => fixture.repo.listLatestRates({ visibility: "surprise" }), /可见性/);

    fixture.repo.saveCollection(site.id, collectionWithGroups([
      detailedGroup("group-1", { groupName: "隐藏分组", rate: 0.1 }),
      detailedGroup("group-2", { groupName: "保留分组", rate: 0.4 })
    ]), "2026-07-13T01:00:00.000Z");
    assert.equal(fixture.repo.listLatestRates({ visibility: "hidden" }).items[0].effectiveRateMultiplier, 0.1);
    assert.equal(fixture.repo.exportPublicData().rates.length, 2);

    assert.deepEqual(fixture.repo.restoreRateGroup(site.id, "group-1"), {
      siteId: site.id,
      groupId: "group-1",
      hidden: false
    });
    assert.deepEqual(fixture.repo.restoreRateGroup(site.id, "group-1"), {
      siteId: site.id,
      groupId: "group-1",
      hidden: false
    });
    assert.equal(fixture.repo.listLatestRates({ visibility: "visible" }).total, 2);

    fixture.repo.hideRateGroup(site.id, "group-1");
    fixture.repo.deleteSite(site.id);
    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM hidden_rate_groups").get().count, 0);
    raw.close();
  } finally {
    await fixture.cleanup();
  }
});

test("repository rejects credential fields", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () => fixture.repo.createSite({
        name: "危险输入",
        baseUrl: "https://secret.example.com",
        token: "secret-token"
      }),
      /凭据/
    );
    assert.throws(
      () => fixture.repo.recordAuthStatus(1, { status: "valid", refreshToken: "secret" }),
      /凭据/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("site authentication metadata round-trips without storing credential values", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({
      name: "认证配置站",
      baseUrl: "https://auth-config.example.com",
      providerId: "sub2api",
      authMode: "sub2api-password"
    });
    assert.equal(site.authMode, "sub2api-password");
    assert.equal(site.credentialConfigured, false);

    const configured = fixture.repo.setSiteAuthConfig(site.id, {
      authMode: "sub2api-password",
      username: "user@example.com",
      credentialRef: `site:${site.id}`
    });
    assert.equal(configured.authUsername, "u***@example.com");
    assert.equal(configured.credentialConfigured, true);
    assert.equal(JSON.stringify(configured).includes("plain-secret"), false);

    const cleared = fixture.repo.clearSiteAuthConfig(site.id);
    assert.equal(cleared.authUsername, "");
    assert.equal(cleared.credentialConfigured, false);
  } finally {
    await fixture.cleanup();
  }
});

test("unchanged rates do not create duplicate history versions", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({ name: "历史站", baseUrl: "https://history.example.com" });
    const first = fixture.repo.saveCollection(site.id, sampleCollection(0.02), "2026-07-13T00:00:00.000Z");
    const same = fixture.repo.saveCollection(site.id, sampleCollection(0.02), "2026-07-13T01:00:00.000Z");
    const changed = fixture.repo.saveCollection(site.id, sampleCollection(0.03), "2026-07-13T02:00:00.000Z");

    assert.equal(first.insertedVersions, 1);
    assert.equal(same.insertedVersions, 0);
    assert.equal(changed.insertedVersions, 1);
    assert.deepEqual(
      fixture.repo.getRateHistory(site.id, "group-1").map((item) => item.effectiveRateMultiplier),
      [0.03, 0.02]
    );
  } finally {
    await fixture.cleanup();
  }
});

test("collections record explicit changes after suppressing the initial baseline", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({ name: "变化站", baseUrl: "https://changes.example.com" });
    const initial = collectionWithGroups([
      detailedGroup("group-1", { rate: 0.2, description: "旧说明", rpmLimit: 10 }),
      detailedGroup("group-2", { rate: 0.4, groupName: "即将删除" })
    ]);
    const run1 = fixture.repo.startRun(site.id, "test", "2026-07-13T00:00:00.000Z");
    const baseline = fixture.repo.saveCollection(site.id, initial, "2026-07-13T00:00:00.000Z", run1);
    assert.equal(baseline.changeCount, 0);
    assert.deepEqual(fixture.repo.listChanges({ siteId: site.id }).items, []);

    const changed = collectionWithGroups([
      detailedGroup("group-1", {
        rate: 0.1,
        description: "新说明",
        status: "inactive",
        subscriptionType: "monthly",
        billingType: "prepaid",
        rpmLimit: 20,
        isExclusive: true,
        dailyLimitUsd: 5,
        peakEnabled: true,
        peakMultiplier: 1.5
      }),
      detailedGroup("group-3", { rate: 0.3, groupName: "新分组" })
    ]);
    const run2 = fixture.repo.startRun(site.id, "test", "2026-07-13T01:00:00.000Z");
    const saved = fixture.repo.saveCollection(site.id, changed, "2026-07-13T01:00:00.000Z", run2);
    assert.equal(saved.changeCount, 11);

    const events = fixture.repo.listChanges({ siteId: site.id, page: 1, pageSize: 50 });
    assert.equal(events.total, 11);
    assert.deepEqual(new Set(events.items.map((event) => event.changeType)), new Set([
      "group_added",
      "group_removed",
      "ratio_changed",
      "desc_changed",
      "status_changed",
      "subscription_type_changed",
      "billing_type_changed",
      "rpm_limit_changed",
      "is_exclusive_changed",
      "limits_changed",
      "peak_rule_changed"
    ]));
    const ratio = events.items.find((event) => event.changeType === "ratio_changed");
    assert.equal(ratio.oldValue, 0.2);
    assert.equal(ratio.newValue, 0.1);
    assert.equal(ratio.changePercent, -50);
    assert.equal(ratio.siteName, "变化站");
    assert.equal(ratio.groupName, "默认组");

    const run3 = fixture.repo.startRun(site.id, "test", "2026-07-13T02:00:00.000Z");
    const unchanged = fixture.repo.saveCollection(site.id, changed, "2026-07-13T02:00:00.000Z", run3);
    assert.equal(unchanged.changeCount, 0);
    assert.equal(fixture.repo.listChanges({ siteId: site.id }).total, 11);
  } finally {
    await fixture.cleanup();
  }
});

test("public export is unpaginated and omits authentication metadata", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({
      name: "导出站",
      baseUrl: "https://export.example.com",
      providerId: "sub2api",
      authMode: "sub2api-password"
    });
    fixture.repo.setSiteAuthConfig(site.id, {
      authMode: "sub2api-password",
      username: "export@example.com",
      credentialRef: `site:${site.id}`
    });
    const baseline = Array.from({ length: 501 }, (_, index) => detailedGroup(`group-${index}`, {
      groupName: `分组 ${index}`,
      rate: 0.2
    }));
    const changed = baseline.map((group) => ({
      ...group,
      baseRateMultiplier: 0.1,
      effectiveRateMultiplier: 0.1,
      peakRate: { ...group.peakRate, effectiveMultiplier: 0.1 }
    }));
    fixture.repo.saveCollection(site.id, { groups: baseline }, "2026-07-13T00:00:00.000Z");
    fixture.repo.saveCollection(site.id, { groups: changed }, "2026-07-13T01:00:00.000Z");

    fixture.repo.checkpoint();
    const exported = fixture.repo.exportPublicData("2026-07-13T03:00:00.000Z");
    assert.equal(exported.formatVersion, 1);
    assert.equal(exported.exportedAt, "2026-07-13T03:00:00.000Z");
    assert.equal(exported.rates.length, 501);
    assert.equal(exported.changes.length, 501);
    assert.equal(exported.sites.length, 1);
    assert.equal(exported.sites[0].authStatus, "unknown");
    const serialized = JSON.stringify(exported);
    assert.equal(serialized.includes("export@example.com"), false);
    assert.equal(serialized.includes("credentialConfigured"), false);
    assert.equal(serialized.includes("credentialRef"), false);
    assert.equal(serialized.includes("external_api_key_hash"), false);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-storage-"));
  const repo = createRepository({ dbPath: path.join(dir, "prices.db") });
  repo.migrate();
  return {
    repo,
    dbPath: path.join(dir, "prices.db"),
    async cleanup() {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function sampleCollection(rate) {
  return {
    groups: [{
      groupId: "group-1",
      groupName: "默认组",
      platform: "openai",
      status: "active",
      baseRateMultiplier: rate,
      userRateMultiplier: null,
      effectiveRateMultiplier: rate,
      peakRate: { enabled: false, start: "", end: "", multiplier: 1, effectiveMultiplier: rate },
      subscriptionType: "",
      billingType: "",
      description: ""
    }]
  };
}

function collectionWithGroups(groups) {
  return { groups };
}

function detailedGroup(groupId, options = {}) {
  const rate = options.rate ?? 0.2;
  const peakEnabled = options.peakEnabled ?? false;
  const peakMultiplier = options.peakMultiplier ?? 1;
  return {
    groupId,
    groupName: options.groupName ?? "默认组",
    platform: "openai",
    status: options.status ?? "active",
    baseRateMultiplier: rate,
    userRateMultiplier: null,
    effectiveRateMultiplier: rate,
    peakRate: {
      enabled: peakEnabled,
      start: peakEnabled ? "09:00" : "",
      end: peakEnabled ? "12:00" : "",
      multiplier: peakMultiplier,
      effectiveMultiplier: peakEnabled ? rate * peakMultiplier : rate
    },
    subscriptionType: options.subscriptionType ?? "",
    billingType: options.billingType ?? "",
    description: options.description ?? "",
    rpmLimit: options.rpmLimit ?? 0,
    isExclusive: options.isExclusive ?? false,
    dailyLimitUsd: options.dailyLimitUsd ?? null,
    weeklyLimitUsd: null,
    monthlyLimitUsd: null
  };
}
