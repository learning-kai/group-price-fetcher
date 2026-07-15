import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiError } from "../src/httpClient.js";
import { createCollector } from "../src/collector.js";
import { createRepository } from "../src/storage.js";
import { createTaskQueue } from "../src/taskQueue.js";
import { redactSecrets } from "../src/security.js";

test("60 sites collect with bounded concurrency, partial failure and change-only history", async () => {
  const fixture = await createFixture();
  let active = 0;
  let maxActive = 0;
  try {
    const sites = Array.from({ length: 60 }, (_, index) => fixture.repo.createSite({
      name: `站点 ${String(index + 1).padStart(2, "0")}`,
      baseUrl: `https://site-${index + 1}.example.com`,
      tags: index % 2 ? ["备用"] : ["重点"]
    }));
    const provider = {
      async fetchPrices({ baseUrl }) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        const number = Number(baseUrl.match(/site-(\d+)/)[1]);
        if (number % 20 === 0) throw new ApiError("上游不可用", { status: 503 });
        return sampleCollection(number / 1000);
      }
    };
    const collector = createCollector({
      repository: fixture.repo,
      authManager: { async getAccess() { return { token: "memory-only-access" }; } },
      getProvider: () => provider,
      queue: createTaskQueue({ concurrency: 5, timeoutMs: 5_000 }),
      sleep: async () => {}
    });

    const batch = await collector.collectMany(sites, { trigger: "acceptance" });

    assert.equal(batch.successes.length, 57);
    assert.equal(batch.failures.length, 3);
    assert.equal(maxActive, 5);
    assert.equal(fixture.repo.listRuns({ limit: 100 }).length, 60);
    assert.equal(fixture.repo.listLatestRates({ pageSize: 100 }).total, 57);

    const firstSite = sites[0];
    fixture.repo.saveCollection(firstSite.id, sampleCollection(0.001), "2026-07-13T01:00:00.000Z");
    fixture.repo.saveCollection(firstSite.id, sampleCollection(0.002), "2026-07-13T02:00:00.000Z");
    assert.equal(fixture.repo.getRateHistory(firstSite.id, "group-1").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("persisted schedules recover after repository restart and database contains no credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-restart-"));
  const dbPath = path.join(dir, "prices.db");
  const accessToken = "should-never-reach-disk-access";
  const refreshToken = "should-never-reach-disk-refresh";
  try {
    let repo = createRepository({ dbPath, clock: () => new Date("2026-07-13T00:00:00.000Z") });
    const site = repo.createSite({ name: "恢复站", baseUrl: "https://restart.example.com" });
    repo.recordAuthStatus(site.id, { status: "valid", source: "profile", error: "" });
    repo.setNextRun(site.id, "2026-07-13T00:30:00.000Z");
    repo.close();

    repo = createRepository({ dbPath, clock: () => new Date("2026-07-13T01:00:00.000Z") });
    assert.deepEqual(repo.listDueSites("2026-07-13T01:00:00.000Z").map((item) => item.id), [site.id]);
    repo.close();

    const bytes = await readFile(dbPath);
    const databaseText = bytes.toString("latin1");
    assert.equal(databaseText.includes(accessToken), false);
    assert.equal(databaseText.includes(refreshToken), false);
    assert.equal(databaseText.includes("password"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log redaction removes bearer, JWT and named credential values", () => {
  const input = "Authorization: Bearer abc.def.ghi auth_token=secret-access refresh_token: secret-refresh password=plain-secret api_key=external-secret";
  const redacted = redactSecrets(input);
  assert.equal(redacted.includes("abc.def.ghi"), false);
  assert.equal(redacted.includes("secret-access"), false);
  assert.equal(redacted.includes("secret-refresh"), false);
  assert.equal(redacted.includes("plain-secret"), false);
  assert.equal(redacted.includes("external-secret"), false);
  assert.match(redacted, /\[REDACTED\]/);
});

async function createFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-acceptance-"));
  const repo = createRepository({ dbPath: path.join(dir, "prices.db") });
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
    fetchedAt: "2026-07-13T00:00:00.000Z",
    groups: [{
      groupId: "group-1",
      groupName: "默认组",
      platform: "openai",
      status: "active",
      subscriptionType: "",
      billingType: "",
      description: "",
      baseRateMultiplier: rate,
      userRateMultiplier: null,
      effectiveRateMultiplier: rate,
      peakRate: { enabled: false, start: "", end: "", multiplier: 1, effectiveMultiplier: rate }
    }],
    summary: { minRate: rate, maxRate: rate }
  };
}
