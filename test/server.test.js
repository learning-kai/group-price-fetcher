import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { createRepository } from "../src/storage.js";

test("management API supports category, site, tag, schedule and pagination workflows", async () => {
  const fixture = await createFixture();
  try {
    const category = await fixture.request("POST", "/api/categories", { name: "稳定站", scheduleMinutes: 30 });
    assert.equal(category.status, 201);
    const site = await fixture.request("POST", "/api/sites", {
      name: "Beta",
      baseUrl: "https://beta.example.com/",
      categoryId: category.body.id,
      tags: ["重点", "Claude"]
    });
    assert.equal(site.status, 201);
    await fixture.request("POST", "/api/sites", { name: "Alpha", baseUrl: "https://alpha.example.com" });

    const listed = await fixture.request("GET", "/api/sites?sortBy=name&sortDir=asc&page=1&pageSize=1&tag=重点");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 1);
    assert.deepEqual(listed.body.items[0].tags, ["Claude", "重点"]);
    assert.equal(listed.body.items[0].effectiveScheduleMinutes, 30);

    const updated = await fixture.request("PATCH", `/api/sites/${site.body.id}`, { scheduleMinutes: 12, enabled: false });
    assert.equal(updated.body.scheduleMinutes, 12);
    assert.equal(updated.body.enabled, false);

    const global = await fixture.request("PUT", "/api/settings/schedule", { minutes: 90 });
    assert.equal(global.body.globalScheduleMinutes, 90);
    const badSort = await fixture.request("GET", "/api/sites?sortBy=drop_table");
    assert.equal(badSort.status, 400);
  } finally {
    await fixture.cleanup();
  }
});

test("rates API supports combined filters, sorting and change history", async () => {
  const fixture = await createFixture();
  try {
    const category = fixture.repo.createCategory({ name: "生产", scheduleMinutes: 60 });
    const site = fixture.repo.createSite({
      name: "倍率站",
      baseUrl: "https://rates.example.com",
      categoryId: category.id,
      tags: ["重点"]
    });
    fixture.repo.saveCollection(site.id, sampleCollection(0.02), "2026-07-13T00:00:00.000Z");
    fixture.repo.saveCollection(site.id, sampleCollection(0.01), "2026-07-13T01:00:00.000Z");

    const rates = await fixture.request("GET", "/api/rates?categoryId=1&tag=重点&platform=openai&sortBy=rate&sortDir=asc");
    assert.equal(rates.status, 200);
    assert.equal(rates.body.items[0].effectiveRateMultiplier, 0.01);

    const history = await fixture.request("GET", `/api/sites/${site.id}/history?groupId=group-1`);
    assert.deepEqual(history.body.items.map((item) => item.effectiveRateMultiplier), [0.01, 0.02]);
  } finally {
    await fixture.cleanup();
  }
});

test("manual refresh and explicit auth actions are routed without exposing secrets", async () => {
  const calls = [];
  const fixture = await createFixture({
    collector: { async collectSite(site) { calls.push(`refresh:${site.id}`); return sampleCollection(0.05); } },
    authManager: {
      async login(site) { calls.push(`login:${site.id}`); return { token: "super-secret", source: "profile:interactive" }; },
      async importFromEdge(site) { calls.push(`import:${site.id}`); return { token: "edge-secret", source: "edge:import" }; }
    }
  });
  try {
    const site = fixture.repo.createSite({ name: "动作站", baseUrl: "https://actions.example.com" });
    const refreshed = await fixture.request("POST", `/api/sites/${site.id}/refresh`);
    const loggedIn = await fixture.request("POST", `/api/sites/${site.id}/login`);
    const imported = await fixture.request("POST", `/api/sites/${site.id}/import-edge`);

    assert.equal(refreshed.status, 200);
    assert.equal(loggedIn.body.source, "profile:interactive");
    assert.equal(imported.body.source, "edge:import");
    assert.deepEqual(calls, [`refresh:${site.id}`, `login:${site.id}`, `import:${site.id}`]);
    assert.equal(JSON.stringify([loggedIn.body, imported.body]).includes("secret"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed JSON is rejected as a client error", async () => {
  const fixture = await createFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/api/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /合法 JSON/);
  } finally {
    await fixture.cleanup();
  }
});

test("API error messages are redacted before reaching the browser", async () => {
  const fixture = await createFixture({
    collector: { async collectSite() { throw new Error("upstream sent Bearer top-secret-value"); } }
  });
  try {
    const site = fixture.repo.createSite({ name: "脱敏站", baseUrl: "https://redact.example.com" });
    const response = await fixture.request("POST", `/api/sites/${site.id}/refresh`);
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.body).includes("top-secret-value"), false);
    assert.match(response.body.error, /\[REDACTED\]/);
  } finally {
    await fixture.cleanup();
  }
});

test("credential endpoints delegate secrets to auth manager and return metadata only", async () => {
  const calls = [];
  const fixture = await createFixture({
    authManager: {
      async configureCredentials(site, input) {
        calls.push({ action: "set", siteId: site.id, input });
        return { ...site, authMode: input.authMode, authUsername: "u***@example.com", credentialConfigured: true };
      },
      async clearCredentials(site) {
        calls.push({ action: "clear", siteId: site.id });
        return { ...site, authUsername: "", credentialConfigured: false };
      },
      async login() { return { token: "hidden", source: "profile:interactive" }; },
      async importFromEdge() { return { token: "hidden", source: "edge:import" }; }
    }
  });
  try {
    const site = fixture.repo.createSite({ name: "账号站", baseUrl: "https://credential.example.com", providerId: "sub2api" });
    const configured = await fixture.request("PUT", `/api/sites/${site.id}/credentials`, {
      authMode: "sub2api-password",
      email: "user@example.com",
      password: "plain-secret"
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.credentialConfigured, true);
    assert.equal(JSON.stringify(configured.body).includes("plain-secret"), false);

    const cleared = await fixture.request("DELETE", `/api/sites/${site.id}/credentials`);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.credentialConfigured, false);
    assert.equal(calls[0].input.password, "plain-secret");
    assert.deepEqual(calls[1], { action: "clear", siteId: site.id });
  } finally {
    await fixture.cleanup();
  }
});

test("recent changes and stable external v1 endpoints expose paginated data", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({ name: "API 站", baseUrl: "https://external.example.com" });
    fixture.repo.saveCollection(site.id, sampleCollection(0.2), "2026-07-13T00:00:00.000Z");
    fixture.repo.saveCollection(site.id, sampleCollection(0.1), "2026-07-13T01:00:00.000Z");

    const changes = await fixture.request("GET", `/api/sites/${site.id}/changes?page=1&pageSize=10`);
    assert.equal(changes.status, 200);
    assert.equal(changes.body.total, 1);
    assert.equal(changes.body.items[0].changeType, "ratio_changed");

    const rates = await fixture.request("GET", "/api/external/v1/rates?sortBy=rate&sortDir=asc&page=1&pageSize=10");
    assert.equal(rates.status, 200);
    assert.equal(rates.body.apiVersion, "1");
    assert.equal(rates.body.data[0].effectiveRateMultiplier, 0.1);
    assert.deepEqual(rates.body.pagination, { page: 1, pageSize: 10, total: 1 });

    const externalChanges = await fixture.request("GET", `/api/external/v1/sites/${site.id}/changes`);
    assert.equal(externalChanges.body.apiVersion, "1");
    assert.equal(externalChanges.body.data[0].changeType, "ratio_changed");
  } finally {
    await fixture.cleanup();
  }
});

test("API key rotation returns the raw key only once", async () => {
  const fixture = await createFixture();
  try {
    const rotated = await fixture.request("POST", "/api/settings/api-key");
    assert.equal(rotated.status, 201);
    assert.equal(typeof rotated.body.apiKey, "string");
    assert.equal(rotated.body.apiKey.length >= 40, true);

    const status = await fixture.request("GET", "/api/settings/api-key");
    assert.deepEqual(status.body, { configured: true });
    assert.equal(JSON.stringify(status.body).includes(rotated.body.apiKey), false);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-server-"));
  const repo = createRepository({ dbPath: path.join(dir, "prices.db") });
  const services = {
    repository: repo,
    collector: overrides.collector ?? { async collectSite() { return sampleCollection(0.02); } },
    authManager: overrides.authManager ?? {
      async login() { return { token: "hidden", source: "profile:interactive" }; },
      async importFromEdge() { return { token: "hidden", source: "edge:import" }; },
      async configureCredentials(site) { return site; },
      async clearCredentials(site) { return site; },
      async close() {}
    },
    scheduler: { status: () => ({ started: false, runningSiteIds: [] }), async start() {}, stop() {} },
    close() {}
  };
  const server = createServer(services);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    repo,
    baseUrl,
    async request(method, pathname, body) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    },
    async cleanup() {
      server.close();
      await once(server, "close");
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
