import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function createFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-storage-"));
  const repo = createRepository({ dbPath: path.join(dir, "prices.db") });
  repo.migrate();
  return {
    repo,
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
