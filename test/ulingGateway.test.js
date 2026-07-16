import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchBatchPrices, parseTargetLines } from "../src/batch.js";
import { EdgeAuthError, clearEdgeTokenCache, extractCandidatesFromText, resolveEdgeToken } from "../src/edgeAuth.js";
import { deriveCurrentRates, fetchPrices, normalizeGroupRate, summarizeGroups, summarizeCurrentRatesByFamily} from "../src/providers/ulingGateway.js";
import { toCsv } from "../src/exporters.js";

test("normalizeGroupRate prefers user-specific multiplier over base multiplier", () => {
  const normalized = normalizeGroupRate({
    id: 7,
    name: "vip",
    platform: "openai",
    rate_multiplier: 1.2,
    peak_rate_enabled: true,
    peak_rate_multiplier: 1.5,
    peak_start: "18:00",
    peak_end: "23:00"
  }, { 7: 0.8 });

  assert.equal(normalized.groupId, 7);
  assert.equal(normalized.baseRateMultiplier, 1.2);
  assert.equal(normalized.userRateMultiplier, 0.8);
  assert.equal(normalized.effectiveRateMultiplier, 0.8);
  assert.equal(normalized.peakRate.effectiveMultiplier, 1.2);
});

test("fetchPrices uses user endpoints and summarizes rates", async () => {
  const calls = [];
  const result = await fetchPrices({
    baseUrl: "https://example.com",
    token: "token",
    mode: "user",
    includeKeys: true
  }, async (request) => {
    calls.push(request.path);
    if (request.path === "/groups/available") {
      return [
        { id: 1, name: "basic", platform: "openai", status: "active", rate_multiplier: 1 },
        { id: 2, name: "pro", platform: "anthropic", status: "inactive", rate_multiplier: 2 }
      ];
    }
    if (request.path === "/groups/rates") return { 2: 1.5 };
    if (request.path === "/keys") return { items: [{ id: 10, name: "dev", group_id: 2 }] };
    throw new Error(`unexpected ${request.path}`);
  });

  assert.deepEqual(calls, ["/groups/available", "/groups/rates", "/keys", "/auth/me"]);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[1].effectiveRateMultiplier, 1.5);
  assert.equal(result.currentRates[0].currentRateMultiplier, 1.5);
  assert.equal(result.summary.currentRateMultiplier, 1.5);
  assert.equal(result.summary.count, 2);
  assert.equal(result.summary.activeCount, 1);
  assert.equal(result.keys.length, 1);
});

test("fetchPrices can collect admin user overrides", async () => {
  const result = await fetchPrices({
    baseUrl: "https://example.com",
    token: "token",
    mode: "admin",
    includeUserOverrides: true
  }, async (request) => {
    if (request.path === "/admin/groups/all") {
      return [{ id: 3, name: "admin", platform: "openai", rate_multiplier: 1 }];
    }
    if (request.path === "/keys") {
      return { items: [{ id: 10, name: "admin-key", group: { id: 3, name: "admin", platform: "openai", rate_multiplier: 1 } }] };
    }
    if (request.path === "/admin/groups/3/rate-multipliers") {
      return [
        { user_id: 1, user_name: "alice", user_email: "a@example.com", rate_multiplier: 0.7 },
        { user_id: 2, user_name: "bob", user_email: "b@example.com", rate_multiplier: null }
      ];
    }
    throw new Error(`unexpected ${request.path}`);
  });

  assert.equal(result.userOverrides.length, 1);
  assert.equal(result.userOverrides[0].rateMultiplier, 0.7);
});

test("summarizeGroups reports min max and average", () => {
  const summary = summarizeGroups([
    { status: "active", platform: "openai", effectiveRateMultiplier: 1 },
    { status: "inactive", platform: "openai", effectiveRateMultiplier: 2 },
    { status: "active", platform: "anthropic", effectiveRateMultiplier: 3 }
  ]);

  assert.equal(summary.count, 3);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.minRate, 1);
  assert.equal(summary.maxRate, 3);
  assert.equal(summary.avgRate, 2);
  assert.deepEqual(summary.platforms, ["anthropic", "openai"]);
});

test("toCsv escapes commas and quotes", () => {
  const csv = toCsv({
    providerId: "x",
    baseUrl: "https://example.com",
    mode: "user",
    groups: [{
      groupId: 1,
      groupName: "a,b",
      platform: "openai",
      status: "active",
      subscriptionType: "standard",
      billingType: "",
      baseRateMultiplier: 1,
      userRateMultiplier: null,
      effectiveRateMultiplier: 1,
      peakRate: { enabled: false, start: "", end: "", multiplier: 1, effectiveMultiplier: 1 },
      rpmLimit: 0,
      dailyLimitUsd: null,
      weeklyLimitUsd: null,
      monthlyLimitUsd: null,
      imagePricing: { price1k: null, price2k: null, price4k: null },
      description: 'quote "here"'
    }]
  });

  assert.match(csv, /"a,b"/);
  assert.match(csv, /"quote ""here"""/);
});

test("deriveCurrentRates reads current key group multiplier", () => {
  const rates = deriveCurrentRates(
    [{
      id: 1,
      name: "prod",
      status: "active",
      groupId: 2,
      groupName: "cheap",
      groupPlatform: "openai",
      groupRateMultiplier: 0.02
    }],
    [normalizeGroupRate({ id: 2, name: "cheap", platform: "openai", rate_multiplier: 0.05 })],
    {}
  );

  assert.equal(rates.length, 1);
  assert.equal(rates[0].currentRateMultiplier, 0.02);
  assert.equal(rates[0].groupName, "cheap");
});

test("deriveCurrentRates applies user-specific group rate override", () => {
  const rates = deriveCurrentRates(
    [{
      id: 1,
      name: "prod",
      status: "active",
      groupId: 2,
      groupName: "cheap",
      groupPlatform: "openai",
      groupRateMultiplier: 0.02
    }],
    [normalizeGroupRate({ id: 2, name: "cheap", platform: "openai", rate_multiplier: 0.02 })],
    { 2: 0.001 }
  );

  assert.equal(rates[0].currentRateMultiplier, 0.001);
  assert.equal(rates[0].source, "groups/rates");
});

test("parseTargetLines supports name url and token env columns", () => {
  const targets = parseTargetLines(`
# comment
站点A | https://a.example.com | SITE_A_TOKEN
https://b.example.com
`, (tokenRef) => ({ SITE_A_TOKEN: "token-a" })[tokenRef]);

  assert.deepEqual(targets, [
    { name: "站点A", baseUrl: "https://a.example.com", token: "token-a" },
    { name: "b.example.com", baseUrl: "https://b.example.com", token: null }
  ]);
});

test("fetchBatchPrices keeps partial successes when one site fails", async () => {
  const provider = {
    id: "fake",
    label: "Fake",
    async fetchPrices({ baseUrl }) {
      if (baseUrl.includes("bad")) throw new Error("boom");
      return {
        providerId: "fake",
        providerLabel: "Fake",
        baseUrl,
        mode: "user",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      groups: [
          normalizeGroupRate({ id: 1, name: "ok", platform: "openai", rate_multiplier: 1 })
        ],
        currentRates: [{
          keyId: 1,
          keyName: "ok-key",
          keyStatus: "active",
          isActive: true,
          groupId: 1,
          groupName: "ok",
          platform: "openai",
          currentRateMultiplier: 1,
          source: "keys.group"
        }],
        keys: null,
        userOverrides: [],
        summary: { count: 1, activeCount: 1, minRate: 1, maxRate: 1, avgRate: 1, platforms: ["openai"] }
      };
    }
  };

  const batch = await fetchBatchPrices({
    provider,
    targets: [
      { name: "good", baseUrl: "https://good.example.com" },
      { name: "bad", baseUrl: "https://bad.example.com" }
    ],
    options: { token: "token", mode: "user" }
  });

  assert.equal(batch.summary.siteCount, 2);
  assert.equal(batch.summary.successCount, 1);
  assert.equal(batch.summary.errorCount, 1);
  assert.equal(batch.summary.groupCount, 1);
  assert.equal(batch.summary.currentMinRate, 1);
  assert.equal(batch.results[0].site.name, "good");
  assert.equal(batch.errors[0].site.name, "bad");
});

test("fetchBatchPrices can resolve token per site when no manual token is provided", async () => {
  const seenTokens = [];
  const provider = {
    id: "fake",
    label: "Fake",
    async fetchPrices({ baseUrl, token }) {
      seenTokens.push([baseUrl, token]);
      return {
        providerId: "fake",
        providerLabel: "Fake",
        baseUrl,
        mode: "user",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        groups: [],
        currentRates: [],
        keys: null,
        userOverrides: [],
        summary: { count: 0, activeCount: 0, minRate: null, maxRate: null, avgRate: null, platforms: [] }
      };
    }
  };

  const batch = await fetchBatchPrices({
    provider,
    targets: [
      { name: "a", baseUrl: "https://a.example.com" },
      { name: "b", baseUrl: "https://b.example.com" }
    ],
    options: {
      mode: "user",
      resolveToken: async (baseUrl) => ({ token: `token-for-${new URL(baseUrl).hostname}`, source: "edge:auth_token" })
    }
  });

  assert.equal(batch.summary.successCount, 2);
  assert.deepEqual(seenTokens, [
    ["https://a.example.com", "token-for-a.example.com"],
    ["https://b.example.com", "token-for-b.example.com"]
  ]);
  assert.equal(batch.results[0].site.authSource, "edge:auth_token");
});

test("fetchBatchPrices preserves Edge auth diagnostics in per-site errors", async () => {
  const detail = {
    origin: "https://stale.example.com",
    diagnostics: [{ profile: "Default", authCandidates: 0, refreshCandidates: 0, authUserRecords: 1 }]
  };
  const provider = {
    id: "fake",
    label: "Fake",
    async fetchPrices() {
      throw new EdgeAuthError("stale login", detail);
    }
  };

  const batch = await fetchBatchPrices({
    provider,
    targets: [{ name: "stale", baseUrl: "https://stale.example.com" }],
    options: { token: "token", mode: "user" }
  });

  assert.equal(batch.summary.errorCount, 1);
  assert.deepEqual(batch.errors[0].detail, detail);
});

test("extractCandidatesFromText finds localStorage token values near an origin and key", () => {
  const text = [
    "noise",
    "https://share-api.com",
    "auth_token",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature_ok",
    "refresh_token",
    "refresh-token-value-12345678901234567890"
  ].join("\u0000");

  assert.deepEqual(
    extractCandidatesFromText(text, "https://share-api.com", "auth_token"),
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature_ok"]
  );
  assert.deepEqual(
    extractCandidatesFromText(text, "https://share-api.com", "refresh_token"),
    ["refresh-token-value-12345678901234567890"]
  );
});

test("extractCandidatesFromText checks every matching key near the origin", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0YXJnZXQifQ.signature_ok";
  const text = [
    "https://api-provider.uling19.com",
    "auth_token",
    "x".repeat(3200),
    "auth_token",
    jwt
  ].join("\u0000");

  assert.deepEqual(
    extractCandidatesFromText(text, "https://api-provider.uling19.com", "auth_token"),
    [jwt]
  );
});

test("extractCandidatesFromText tolerates LevelDB keys with a missing first byte", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZXZlbGRiIn0.signature_ok";
  const text = [
    "https://api-provider.uling19.com",
    "uth_token",
    jwt
  ].join("\u0000");

  assert.deepEqual(
    extractCandidatesFromText(text, "https://api-provider.uling19.com", "auth_token"),
    [jwt]
  );
});

test("extractCandidatesFromText ignores token-like keys before the matching origin", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3cm9uZyJ9.signature_ok";
  const text = [
    "lc_auth_token",
    jwt,
    "https://share-api.com",
    "auth_user",
    "{\"id\":233}"
  ].join("\u0000");

  assert.deepEqual(
    extractCandidatesFromText(text, "https://share-api.com", "auth_token"),
    []
  );
});

test("extractCandidatesFromText does not cross into another origin record", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.signature_ok";
  const text = [
    "https://m.stripe.network/^0https://share-api.com",
    "muffins",
    "chrome-extension://hajlmbnnniemimmaehcefkamdadpjlfa",
    "https://www.dieqiyun.top",
    "auth_token",
    jwt
  ].join("\u0000");

  assert.deepEqual(
    extractCandidatesFromText(text, "https://share-api.com", "auth_token"),
    []
  );
});

test("resolveEdgeToken caches a valid Edge token in memory", async () => {
  clearEdgeTokenCache();
  const root = await mkdtemp(path.join(tmpdir(), "edge-auth-test-"));
  const levelDb = path.join(root, "Default", "Local Storage", "leveldb");
  await mkdir(levelDb, { recursive: true });
  await writeFile(
    path.join(levelDb, "000001.log"),
    [
      "https://cache.example.com",
      "auth_token",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYWNoZSJ9.signature_ok"
    ].join("\u0000")
  );

  let calls = 0;
  const first = await resolveEdgeToken("https://cache.example.com", {
    edgeRoot: root,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 0, data: { id: 1 } }), { status: 200 });
    }
  });
  const second = await resolveEdgeToken("https://cache.example.com", {
    edgeRoot: root,
    fetchImpl: async () => {
      throw new Error("cache miss");
    }
  });

  assert.equal(calls, 1);
  assert.equal(first.token, second.token);
  assert.equal(second.source, "edge:auth_token");
  await rm(root, { recursive: true, force: true });
  clearEdgeTokenCache();
});

test("resolveEdgeToken reports auth_user records when Edge has stale login residue", async () => {
  clearEdgeTokenCache();
  const root = await mkdtemp(path.join(tmpdir(), "edge-auth-stale-test-"));
  const levelDb = path.join(root, "Default", "Local Storage", "leveldb");
  await mkdir(levelDb, { recursive: true });
  await writeFile(
    path.join(levelDb, "000001.log"),
    [
      "https://stale.example.com",
      "auth_user",
      "{\"id\":1,\"email\":\"user@example.com\"}"
    ].join("\u0000")
  );

  await assert.rejects(
    resolveEdgeToken("https://stale.example.com", {
      edgeRoot: root,
      allowRefresh: false
    }),
    (error) => {
      assert.ok(error instanceof EdgeAuthError);
      assert.equal(error.details.diagnostics[0].authUserRecords, 1);
      assert.equal(error.details.diagnostics[0].authCandidates, 0);
      assert.equal(error.details.diagnostics[0].refreshCandidates, 0);
      return true;
    }
  );

  await rm(root, { recursive: true, force: true });
  clearEdgeTokenCache();
});

test("resolveEdgeToken waits for Edge to write a token after opening the site", async () => {
  clearEdgeTokenCache();
  const root = await mkdtemp(path.join(tmpdir(), "edge-auth-wait-test-"));
  const levelDb = path.join(root, "Default", "Local Storage", "leveldb");
  await mkdir(levelDb, { recursive: true });
  await writeFile(
    path.join(levelDb, "000001.log"),
    [
      "https://wait.example.com",
      "auth_user",
      "{\"id\":1}"
    ].join("\u0000")
  );

  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3YWl0In0.signature_ok";
  const delayedWrite = setTimeout(async () => {
    await writeFile(
      path.join(levelDb, "000002.log"),
      [
        "https://wait.example.com",
        "auth_token",
        token
      ].join("\u0000")
    );
  }, 80);

  const resolved = await resolveEdgeToken("https://wait.example.com", {
    edgeRoot: root,
    openEdgeOnFailure: true,
    edgeExecutable: process.execPath,
    edgeSettleMs: 10,
    edgeWaitMs: 400,
    edgePollMs: 25,
    allowRefresh: false,
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { id: 1 } }), { status: 200 })
  });

  clearTimeout(delayedWrite);
  assert.equal(resolved.token, token);
  assert.equal(resolved.source, "edge:auth_token");
  await rm(root, { recursive: true, force: true });
  clearEdgeTokenCache();
});

test("toCsv includes site columns for batch group exports", async () => {
  const csv = toCsv({
    batch: true,
    results: [{
      providerId: "fake",
      baseUrl: "https://a.example.com",
      mode: "user",
      site: { name: "A", baseUrl: "https://a.example.com" },
      groups: [{
        groupId: 1,
        groupName: "basic",
        platform: "openai",
        status: "active",
        subscriptionType: "standard",
        billingType: "",
        baseRateMultiplier: 1,
        userRateMultiplier: null,
        effectiveRateMultiplier: 1,
        peakRate: { enabled: false, start: "", end: "", multiplier: 1, effectiveMultiplier: 1 },
        rpmLimit: 0,
        dailyLimitUsd: null,
        weeklyLimitUsd: null,
        monthlyLimitUsd: null,
        imagePricing: { price1k: null, price2k: null, price4k: null },
        description: ""
      }]
    }]
  });

  assert.match(csv.split("\n")[0], /^site_name,site_url,/);
  assert.match(csv, /^site_name[\s\S]*\nA,https:\/\/a\.example\.com,/);
});

test("toCsv exports current rates when available", async () => {
  const csv = toCsv({
    batch: true,
    results: [{
      providerId: "fake",
      baseUrl: "https://a.example.com",
      mode: "user",
      site: { name: "A", baseUrl: "https://a.example.com" },
      currentRates: [{
        keyId: 1,
        keyName: "prod",
        keyStatus: "active",
        groupId: 2,
        groupName: "cheap",
        platform: "openai",
        currentRateMultiplier: 0.02,
        source: "keys.group"
      }],
      groups: []
    }]
  });

  assert.match(csv.split("\n")[0], /^site_name,site_url,current_rate_multiplier,/);
  assert.match(csv, /A,https:\/\/a\.example\.com,0\.02,/);
});


test("gpt groupName is captured for exact 1111 identity", () => {
  const groups = [
    { groupId: "g1", groupName: "ChatGPTdefault", platform: "openai", status: "active", effectiveRateMultiplier: 0.01 },
    { groupId: "g2", groupName: "福利Grok", platform: "grok", status: "active", effectiveRateMultiplier: 0.001 },
  ];
  const currentRates = [
    { keyName: "1111", groupName: "ChatGPTdefault", currentRateMultiplier: 0.01, isActive: true },
    { keyName: "grok", groupName: "福利Grok", currentRateMultiplier: 0.001, isActive: true },
  ];
  const summary = summarizeCurrentRatesByFamily(groups, currentRates, [
    { id: 1, name: "1111" },
    { id: 2, name: "grok" },
  ]);
  assert.equal(summary.gpt.currentRateKeyName, "1111");
  assert.equal(summary.gpt.currentRateGroupName, "ChatGPTdefault");
  assert.equal(summary.grok.currentRateKeyName, "grok");
  assert.equal(summary.grok.currentRateGroupName, "福利Grok");
});
