import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/httpClient.js";
import { createTaskQueue } from "../src/taskQueue.js";
import { createCollector, classifyCollectionError } from "../src/collector.js";
import { probeCompatibility } from "../src/providers/ulingGateway.js";

test("task queue never exceeds configured concurrency", async () => {
  const queue = createTaskQueue({ concurrency: 3, timeoutMs: 1_000 });
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 20 }, (_, index) => queue.add(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));

  assert.deepEqual(await Promise.all(jobs), Array.from({ length: 20 }, (_, index) => index));
  assert.equal(maxActive, 3);
  assert.deepEqual(queue.stats(), { active: 0, pending: 0, concurrency: 3 });
});

test("collector refreshes authentication once after a provider 401", async () => {
  const fixture = collectorFixture({
    provider: sequenceProvider([
      new ApiError("expired", { status: 401 }),
      sampleResult(0.02)
    ])
  });

  const result = await fixture.collector.collectSite(fixture.site, { trigger: "manual" });

  assert.equal(result.summary.minRate, 0.02);
  assert.deepEqual(fixture.authCalls, [false, true]);
  assert.equal(fixture.finishedRuns[0].status, "success");
});

test("collector honors Retry-After and retries 429 without opening login", async () => {
  const sleeps = [];
  const fixture = collectorFixture({
    provider: sequenceProvider([
      new ApiError("limited", { status: 429, retryAfterMs: 2_000 }),
      sampleResult(0.03)
    ]),
    sleep: async (ms) => sleeps.push(ms)
  });

  await fixture.collector.collectSite(fixture.site);

  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(fixture.authCalls, [false]);
});

test("collector retries transient 5xx with bounded exponential backoff", async () => {
  const sleeps = [];
  const fixture = collectorFixture({
    provider: sequenceProvider([
      new ApiError("upstream", { status: 503 }),
      new ApiError("upstream", { status: 503 }),
      sampleResult(0.04)
    ]),
    sleep: async (ms) => sleeps.push(ms)
  });

  await fixture.collector.collectSite(fixture.site);

  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test("403 is classified as permission failure and is not retried", async () => {
  const provider = sequenceProvider([new ApiError("forbidden", { status: 403 })]);
  const fixture = collectorFixture({ provider });

  await assert.rejects(() => fixture.collector.collectSite(fixture.site), /forbidden/);

  assert.equal(provider.calls, 1);
  assert.equal(fixture.finishedRuns[0].errorCode, "PERMISSION_DENIED");
  assert.deepEqual(classifyCollectionError(new ApiError("limited", { status: 429 })).code, "RATE_LIMITED");
});

test("collectMany preserves partial successes", async () => {
  const fixture = collectorFixture({
    provider: {
      async fetchPrices({ baseUrl }) {
        if (baseUrl.includes("bad")) throw new ApiError("offline", { status: 503 });
        return sampleResult(0.01);
      }
    },
    sleep: async () => {}
  });
  const sites = [fixture.site, { ...fixture.site, id: 2, name: "失败站", baseUrl: "https://bad.example.com" }];

  const batch = await fixture.collector.collectMany(sites);

  assert.equal(batch.successes.length, 1);
  assert.equal(batch.failures.length, 1);
  assert.equal(batch.failures[0].site.id, 2);
});

test("provider compatibility probe verifies auth and group endpoints", async () => {
  const calls = [];
  const result = await probeCompatibility(
    { baseUrl: "https://probe.example.com", token: "token" },
    async ({ path }) => {
      calls.push(path);
      if (path === "/auth/me") return { id: 1 };
      return [{ id: "group-1" }];
    }
  );

  assert.deepEqual(calls, ["/auth/me", "/groups/available"]);
  assert.deepEqual(result, { compatible: true, providerId: "uling-gateway", groupCount: 1 });
});

test("collector probes a site with authenticated provider state", async () => {
  const calls = [];
  const fixture = collectorFixture({
    provider: {
      async probeCompatibility(options) {
        calls.push(options);
        return { compatible: true, providerId: "uling-gateway", groupCount: 4 };
      },
      async fetchPrices() { return sampleResult(0.02); }
    }
  });

  const result = await fixture.collector.probeSite(fixture.site);

  assert.equal(result.groupCount, 4);
  assert.deepEqual(calls, [{ baseUrl: fixture.site.baseUrl, token: "initial", headers: {} }]);
});

test("collector forwards provider-specific authentication headers", async () => {
  const calls = [];
  const fixture = collectorFixture({
    authManager: {
      async getAccess() {
        return {
          token: "",
          headers: { Authorization: "system-token", "New-Api-User": "123" },
          source: "newapi:token"
        };
      }
    },
    provider: {
      async fetchPrices(options) {
        calls.push(options);
        return sampleResult(0.02);
      }
    }
  });

  await fixture.collector.collectSite({ ...fixture.site, providerId: "newapi", authMode: "newapi-token" });

  assert.deepEqual(calls[0].headers, { Authorization: "system-token", "New-Api-User": "123" });
});

function collectorFixture(options = {}) {
  let nextRunId = 1;
  const finishedRuns = [];
  const authCalls = [];
  const repository = {
    startRun() { return nextRunId++; },
    saveCollection() { return { insertedVersions: 1 }; },
    finishRun(_id, input) { finishedRuns.push(input); return input; }
  };
  const authManager = options.authManager ?? {
    async getAccess(_site, authOptions = {}) {
      authCalls.push(Boolean(authOptions.forceRefresh));
      return { token: authOptions.forceRefresh ? "refreshed" : "initial" };
    }
  };
  const provider = options.provider ?? sequenceProvider([sampleResult(0.02)]);
  const collector = createCollector({
    repository,
    authManager,
    getProvider: () => provider,
    queue: createTaskQueue({ concurrency: 3, timeoutMs: 2_000 }),
    sleep: options.sleep ?? (async () => {})
  });
  return {
    collector,
    repository,
    authCalls,
    finishedRuns,
    site: { id: 1, name: "正常站", baseUrl: "https://good.example.com", providerId: "uling-gateway" }
  };
}

function sequenceProvider(sequence) {
  let index = 0;
  return {
    calls: 0,
    async fetchPrices() {
      this.calls += 1;
      const item = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (item instanceof Error) throw item;
      return item;
    }
  };
}

function sampleResult(rate) {
  return {
    fetchedAt: "2026-07-13T00:00:00.000Z",
    groups: [{
      groupId: "group-1",
      groupName: "默认组",
      platform: "openai",
      status: "active",
      baseRateMultiplier: rate,
      userRateMultiplier: null,
      effectiveRateMultiplier: rate,
      peakRate: { enabled: false, multiplier: 1, effectiveMultiplier: rate }
    }],
    summary: { minRate: rate, maxRate: rate }
  };
}
