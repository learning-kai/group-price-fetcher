import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExportService } from "../src/exportService.js";
import { createApiRouter } from "../src/routes.js";
import { createBrowserAdapter, createServer } from "../src/server.js";
import { createRepository } from "../src/storage.js";

test("Linux browser adapter reports that Edge profile authentication is unavailable", async () => {
  const adapter = createBrowserAdapter({ profileDir: "/unused", platform: "linux" });
  await assert.rejects(
    () => adapter.readState(),
    (error) => error.code === "BROWSER_AUTH_UNAVAILABLE" && error.status === 501
  );
  await adapter.close();
});

test("status API reports whether browser authentication is supported", async () => {
  const fixture = await createFixture({ browserAuthSupported: false });
  try {
    const status = await fixture.request("GET", "/api/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.browserAuthSupported, false);
  } finally {
    await fixture.cleanup();
  }
});

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

test("management API hides and restores rate groups without filtering external data", async () => {
  const fixture = await createFixture();
  try {
    const site = fixture.repo.createSite({ name: "隐藏站", baseUrl: "https://hidden.example.com" });
    fixture.repo.saveCollection(site.id, sampleCollection(0.02), "2026-07-13T00:00:00.000Z");

    const hidden = await fixture.request("PUT", `/api/sites/${site.id}/groups/group-1/hidden`);
    assert.equal(hidden.status, 200);
    assert.deepEqual(hidden.body, { siteId: site.id, groupId: "group-1", hidden: true });

    const visibleRates = await fixture.request("GET", "/api/rates");
    assert.equal(visibleRates.body.total, 0);
    const hiddenRates = await fixture.request("GET", "/api/rates?visibility=hidden");
    assert.equal(hiddenRates.body.total, 1);
    assert.equal(hiddenRates.body.items[0].hidden, true);
    const invalid = await fixture.request("GET", "/api/rates?visibility=surprise");
    assert.equal(invalid.status, 400);

    const externalRates = await fixture.request("GET", "/api/external/v1/rates");
    assert.equal(externalRates.body.pagination.total, 1);
    assert.equal(externalRates.body.data[0].groupId, "group-1");

    const restored = await fixture.request("DELETE", `/api/sites/${site.id}/groups/group-1/hidden`);
    assert.deepEqual(restored.body, { siteId: site.id, groupId: "group-1", hidden: false });
    const restoredAgain = await fixture.request("DELETE", `/api/sites/${site.id}/groups/group-1/hidden`);
    assert.deepEqual(restoredAgain.body, restored.body);
    assert.equal((await fixture.request("GET", "/api/rates")).body.total, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("site conversion is exposed consistently by management and external APIs", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.request("POST", "/api/sites", {
      name: "换算站",
      baseUrl: "https://conversion.example.com",
      rateConversionFactor: 0.1
    });
    fixture.repo.saveCollection(created.body.id, sampleCollection(0.8), "2026-07-13T00:00:00.000Z");

    const rates = await fixture.request("GET", `/api/rates?siteId=${created.body.id}`);
    assert.deepEqual({
      source: rates.body.items[0].sourceEffectiveRateMultiplier,
      factor: rates.body.items[0].rateConversionFactor,
      effective: rates.body.items[0].effectiveRateMultiplier
    }, { source: 0.8, factor: 0.1, effective: 0.08 });

    const externalRates = await fixture.request("GET", `/api/external/v1/sites/${created.body.id}/rates`);
    assert.equal(externalRates.body.data[0].sourceEffectiveRateMultiplier, 0.8);
    assert.equal(externalRates.body.data[0].rateConversionFactor, 0.1);
    assert.equal(externalRates.body.data[0].effectiveRateMultiplier, 0.08);
    const externalSites = await fixture.request("GET", "/api/external/v1/sites");
    assert.equal(externalSites.body.data[0].rateConversionFactor, 0.1);
  } finally {
    await fixture.cleanup();
  }
});

test("hidden rate group controls reject non-loopback clients before repository access", async () => {
  const route = createApiRouter({
    repository: {
      getExternalApiKeyHash() { return ""; },
      setExternalApiKeyHash() {},
      getSite() { throw new Error("repository should not be called"); }
    }
  });

  for (const method of ["PUT", "DELETE"]) {
    await assert.rejects(
      route({
        method,
        url: new URL("/api/sites/1/groups/group-1/hidden", "http://localhost"),
        remoteAddress: "192.168.1.8"
      }),
      (error) => error.status === 403 && error.code === "MANAGEMENT_LOCAL_ONLY"
    );
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

test("local export endpoints download JSON, CSV and encrypted backup artifacts", async () => {
  const calls = [];
  const fixture = await createFixture({
    exportService: {
      async exportDataJson() {
        return artifact("data.json", "application/json; charset=utf-8", JSON.stringify({
          formatVersion: 1,
          sites: [],
          rates: [],
          changes: []
        }));
      },
      async exportRatesCsv() {
        return artifact("rates.csv", "text/csv; charset=utf-8", "\uFEFFsite_name,rate\n");
      },
      async exportEncryptedBackup(password) {
        calls.push(password);
        return artifact("backup.gpfbackup", "application/octet-stream", "encrypted-bytes");
      }
    }
  });
  try {
    const json = await fetch(`${fixture.baseUrl}/api/exports/data.json`);
    assert.equal(json.status, 200);
    assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(json.headers.get("content-disposition"), 'attachment; filename="data.json"');
    assert.equal(json.headers.get("cache-control"), "no-store");
    assert.equal(json.headers.get("x-content-type-options"), "nosniff");
    const jsonBytes = Buffer.from(await json.arrayBuffer());
    assert.equal(Number(json.headers.get("content-length")), jsonBytes.length);
    assert.deepEqual(JSON.parse(jsonBytes.toString("utf8")), { formatVersion: 1, sites: [], rates: [], changes: [] });

    const csv = await fetch(`${fixture.baseUrl}/api/exports/rates.csv`);
    assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="rates.csv"');
    const csvBytes = Buffer.from(await csv.arrayBuffer());
    assert.equal(Number(csv.headers.get("content-length")), csvBytes.length);
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.equal(csvBytes.subarray(3).toString("utf8"), "site_name,rate\n");

    const backup = await fetch(`${fixture.baseUrl}/api/exports/encrypted-backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" })
    });
    assert.equal(backup.headers.get("content-disposition"), 'attachment; filename="backup.gpfbackup"');
    const backupBytes = Buffer.from(await backup.arrayBuffer());
    assert.equal(Number(backup.headers.get("content-length")), backupBytes.length);
    assert.equal(backupBytes.toString("utf8"), "encrypted-bytes");
    assert.deepEqual(calls, ["correct horse battery staple"]);
  } finally {
    await fixture.cleanup();
  }
});

test("local site transfer endpoints export an artifact and import its encrypted text", async () => {
  const calls = [];
  const fixture = await createFixture({
    siteTransferService: {
      async exportTransfer(password) {
        calls.push(["export", password]);
        return artifact("sites.gpftransfer", "application/octet-stream", "encrypted-sites");
      },
      async importTransfer(transfer, password) {
        calls.push(["import", transfer, password]);
        return { created: 2, overwritten: 1, needsCredentials: 1, failed: 0, errors: [] };
      }
    }
  });
  try {
    const exported = await fetch(`${fixture.baseUrl}/api/transfers/sites/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "site-transfer-password" })
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-disposition"), 'attachment; filename="sites.gpftransfer"');
    assert.equal(await exported.text(), "encrypted-sites");

    const imported = await fixture.request("POST", "/api/transfers/sites/import", {
      password: "site-transfer-password",
      transfer: "encrypted-sites"
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body, { created: 2, overwritten: 1, needsCredentials: 1, failed: 0, errors: [] });
    assert.deepEqual(calls, [
      ["export", "site-transfer-password"],
      ["import", "encrypted-sites", "site-transfer-password"]
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("browser session capture returns tokens once with no-store caching", async () => {
  const calls = [];
  const fixture = await createFixture({
    browserAuthSupported: true,
    authManager: {
      async captureBrowserSession(site) {
        calls.push(site.id);
        return { accessToken: "portable-access", refreshToken: "portable-refresh" };
      }
    }
  });
  try {
    const site = fixture.repo.createSite({
      name: "提取站",
      baseUrl: "https://capture.example.com",
      providerId: "sub2api",
      authMode: "edge-profile"
    });
    const response = await fetch(`${fixture.baseUrl}/api/sites/${site.id}/capture-browser-session`, {
      method: "POST"
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      accessToken: "portable-access",
      refreshToken: "portable-refresh"
    });
    assert.deepEqual(calls, [site.id]);
  } finally {
    await fixture.cleanup();
  }
});

test("browser session capture remains protected by loopback management access", async () => {
  let calls = 0;
  const route = createApiRouter({
    repository: {
      getExternalApiKeyHash() { return ""; },
      setExternalApiKeyHash() {},
      getSite() { throw new Error("repository should not be called"); }
    },
    authManager: {
      async captureBrowserSession() { calls += 1; }
    },
    browserAuthSupported: true
  });

  await assert.rejects(
    route({
      method: "POST",
      url: new URL("/api/sites/1/capture-browser-session", "http://localhost"),
      remoteAddress: "192.168.1.8"
    }),
    (error) => error.status === 403 && error.code === "MANAGEMENT_LOCAL_ONLY"
  );
  assert.equal(calls, 0);
});

test("export router returns exactly four business download headers", async () => {
  const route = createApiRouter({
    repository: {
      getExternalApiKeyHash() { return ""; },
      setExternalApiKeyHash() {}
    },
    exportService: {
      async exportDataJson() { return artifact("data.json", "application/json", "{}"); },
      async exportRatesCsv() { return artifact("rates.csv", "text/csv", "rates"); },
      async exportEncryptedBackup() { return artifact("backup.gpfbackup", "application/octet-stream", "backup"); }
    }
  });
  const requests = [
    ["GET", "/api/exports/data.json", {}],
    ["GET", "/api/exports/rates.csv", {}],
    ["POST", "/api/exports/encrypted-backup", { password: "router-test-password" }]
  ];
  const expectedHeaders = ["Cache-Control", "Content-Disposition", "Content-Type", "X-Content-Type-Options"];

  for (const [method, pathname, body] of requests) {
    const response = await route({
      method,
      url: new URL(pathname, "http://localhost"),
      body,
      remoteAddress: "127.0.0.1"
    });
    assert.deepEqual(Object.keys(response.headers).sort(), expectedHeaders);
  }
});

test("local export endpoints reject non-loopback clients before invoking the export service", async () => {
  const calls = [];
  const route = createApiRouter({
    repository: {
      getExternalApiKeyHash() { return ""; },
      setExternalApiKeyHash() {}
    },
    exportService: {
      async exportDataJson() { calls.push("data.json"); },
      async exportRatesCsv() { calls.push("rates.csv"); },
      async exportEncryptedBackup() { calls.push("encrypted-backup"); }
    }
  });
  const requests = [
    ["GET", "/api/exports/data.json", {}],
    ["GET", "/api/exports/rates.csv", {}],
    ["POST", "/api/exports/encrypted-backup", { password: "remote-export-test-password" }]
  ];

  for (const [method, pathname, body] of requests) {
    await assert.rejects(
      route({
        method,
        url: new URL(pathname, "http://localhost"),
        body,
        remoteAddress: "192.168.1.8"
      }),
      (error) => error.status === 403 && error.code === "MANAGEMENT_LOCAL_ONLY"
    );
  }
  assert.deepEqual(calls, []);
});

test("encrypted backup endpoint maps real password validation failures to a stable client error", async () => {
  const fixture = await createFixture({
    exportServiceFactory({ repository, dbPath }) {
      return createExportService({
        repository,
        dbPath,
        credentialStore: { async exportAll() { return {}; } }
      });
    }
  });
  try {
    for (const body of [{}, { password: "too-short" }]) {
      const response = await fixture.request("POST", "/api/exports/encrypted-backup", body);
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "BACKUP_PASSWORD_INVALID");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("encrypted export errors do not expose the submitted password in responses or logs", async () => {
  const password = "encrypted-export-test-password-7d42";
  const logs = [];
  const originalConsoleError = console.error;
  const fixture = await createFixture({
    exportService: {
      async exportDataJson() { throw new Error("not used"); },
      async exportRatesCsv() { throw new Error("not used"); },
      async exportEncryptedBackup() {
        const detail = {
          nested: { value: `nested ${password}` },
          [`field-${password}`]: "password used as an object key"
        };
        detail.self = detail;
        throw Object.assign(new Error(`encryption failed while using ${password}`), {
          status: 502,
          code: "ENCRYPTION_FAILED",
          detail
        });
      }
    }
  });
  console.error = (...args) => logs.push(args.map(String).join(" "));
  try {
    const response = await fixture.request("POST", "/api/exports/encrypted-backup", { password });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, "ENCRYPTION_FAILED");
    assert.equal(JSON.stringify(response.body).includes(password), false);
    assert.equal(logs.some((line) => line.includes(password)), false);
  } finally {
    console.error = originalConsoleError;
    await fixture.cleanup();
  }
});

async function createFixture(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-server-"));
  const dbPath = path.join(dir, "prices.db");
  const repo = createRepository({ dbPath });
  const exportService = overrides.exportServiceFactory
    ? overrides.exportServiceFactory({ repository: repo, dbPath })
    : overrides.exportService;
  const services = {
    repository: repo,
    browserAuthSupported: overrides.browserAuthSupported ?? false,
    collector: overrides.collector ?? { async collectSite() { return sampleCollection(0.02); } },
    authManager: overrides.authManager ?? {
      async login() { return { token: "hidden", source: "profile:interactive" }; },
      async importFromEdge() { return { token: "hidden", source: "edge:import" }; },
      async configureCredentials(site) { return site; },
      async clearCredentials(site) { return site; },
      async close() {}
    },
    scheduler: { status: () => ({ started: false, runningSiteIds: [] }), async start() {}, stop() {} },
    exportService: exportService ?? {
      async exportDataJson() { throw new Error("not configured"); },
      async exportRatesCsv() { throw new Error("not configured"); },
      async exportEncryptedBackup() { throw new Error("not configured"); }
    },
    siteTransferService: overrides.siteTransferService ?? {
      async exportTransfer() { throw new Error("not configured"); },
      async importTransfer() { throw new Error("not configured"); }
    },
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

function artifact(filename, contentType, body) {
  return { filename, contentType, body: Buffer.from(body, "utf8") };
}
