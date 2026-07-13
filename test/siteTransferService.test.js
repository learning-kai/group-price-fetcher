import test from "node:test";
import assert from "node:assert/strict";
import { decryptBackup, encryptBackup } from "../src/backupCrypto.js";
import { createAuthManager } from "../src/authManager.js";
import { createSiteTransferService } from "../src/siteTransferService.js";
import { createRepository } from "../src/storage.js";

const PASSWORD = "correct horse battery staple";

test("site transfer export contains only portable site configuration and credentials", async () => {
  const fixture = createFixture("2026-07-13T08:09:10.000Z");
  try {
    const category = fixture.repository.createCategory({ name: "生产", scheduleMinutes: 15 });
    const site = fixture.repository.createSite({
      name: "十倍余额站",
      baseUrl: "https://transfer.example.com/",
      providerId: "sub2api",
      categoryId: category.id,
      scheduleMinutes: 30,
      tags: ["重点", "Claude"],
      enabled: true,
      authMode: "sub2api-password",
      rateConversionFactor: 0.1
    });
    await fixture.authManager.configureCredentials(site, {
      authMode: "sub2api-password",
      email: "user@example.com",
      password: "plain-secret"
    });
    fixture.repository.saveCollection(site.id, sampleCollection(), "2026-07-13T01:00:00.000Z");
    fixture.repository.hideRateGroup(site.id, "group-1");
    fixture.repository.setExternalApiKeyHash("a".repeat(64));

    const artifact = await fixture.service.exportTransfer(PASSWORD);
    assert.equal(artifact.filename, "group-price-sites-20260713-080910.gpftransfer");
    assert.equal(artifact.contentType, "application/octet-stream");
    assert.equal(artifact.body.includes("plain-secret"), false);
    assert.equal(artifact.body.includes("user@example.com"), false);

    const payload = await decryptBackup(artifact.body, PASSWORD);
    assert.deepEqual(payload, {
      payloadType: "site-transfer",
      payloadVersion: 1,
      createdAt: "2026-07-13T08:09:10.000Z",
      sites: [{
        name: "十倍余额站",
        baseUrl: "https://transfer.example.com",
        providerId: "sub2api",
        categoryName: "生产",
        tags: ["Claude", "重点"],
        scheduleMinutes: 30,
        enabled: true,
        rateConversionFactor: 0.1,
        authMode: "sub2api-password",
        credentials: { email: "user@example.com", password: "plain-secret" }
      }]
    });
    const serializedPayload = JSON.stringify(payload);
    for (const forbidden of ["database", "rates", "changes", "apiKey", "hiddenRateGroups", "authStatus", "edgeProfile"]) {
      assert.equal(serializedPayload.includes(forbidden), false, `unexpected field ${forbidden}`);
    }
  } finally {
    fixture.close();
  }
});

test("site transfer import overwrites by normalized URL and preserves local rate history", async () => {
  const fixture = createFixture();
  try {
    const existing = fixture.repository.createSite({
      name: "旧名称",
      baseUrl: "https://same.example.com/",
      providerId: "sub2api",
      tags: ["旧标签"],
      authMode: "sub2api-password"
    });
    await fixture.authManager.configureCredentials(existing, {
      authMode: "sub2api-password",
      email: "old@example.com",
      password: "old-secret"
    });
    fixture.repository.saveCollection(existing.id, sampleCollection(), "2026-07-13T01:00:00.000Z");
    fixture.repository.hideRateGroup(existing.id, "group-1");

    const transfer = await encryptBackup({
      payloadType: "site-transfer",
      payloadVersion: 1,
      createdAt: "2026-07-13T02:00:00.000Z",
      sites: [
        {
          name: "覆盖后的名称",
          baseUrl: "https://same.example.com",
          providerId: "sub2api",
          categoryName: "生产",
          tags: ["新标签"],
          scheduleMinutes: 45,
          enabled: true,
          rateConversionFactor: 0.1,
          authMode: "sub2api-password",
          credentials: null
        },
        {
          name: "NewAPI 站",
          baseUrl: "https://new.example.com/",
          providerId: "newapi",
          categoryName: null,
          tags: [],
          scheduleMinutes: null,
          enabled: true,
          rateConversionFactor: 1,
          authMode: "newapi-token",
          credentials: { accessToken: "new-token", userId: "42" }
        },
        {
          name: "浏览器登录站",
          baseUrl: "https://edge.example.com",
          providerId: "sub2api",
          categoryName: "生产",
          tags: ["手工登录"],
          scheduleMinutes: null,
          enabled: true,
          rateConversionFactor: 1,
          authMode: "edge-profile",
          credentials: null
        }
      ]
    }, PASSWORD);

    assert.deepEqual(await fixture.service.importTransfer(transfer, PASSWORD), {
      created: 2,
      overwritten: 1,
      needsCredentials: 2,
      failed: 0,
      errors: []
    });

    const overwritten = fixture.repository.getSiteByBaseUrl("https://same.example.com/");
    assert.equal(overwritten.id, existing.id);
    assert.equal(overwritten.name, "覆盖后的名称");
    assert.equal(overwritten.categoryName, "生产");
    assert.deepEqual(overwritten.tags, ["新标签"]);
    assert.equal(overwritten.scheduleMinutes, 45);
    assert.equal(overwritten.rateConversionFactor, 0.1);
    assert.equal(overwritten.credentialConfigured, false);
    assert.equal(await fixture.credentialStore.get(`site:${existing.id}`), null);
    assert.equal(fixture.repository.getRateHistory(existing.id, "group-1").length, 1);
    assert.equal(fixture.repository.listLatestRates({ visibility: "hidden" }).items[0].siteId, existing.id);

    const newApi = fixture.repository.getSiteByBaseUrl("https://new.example.com");
    assert.deepEqual(await fixture.credentialStore.get(`site:${newApi.id}`), {
      accessToken: "new-token",
      userId: "42"
    });
    const edge = fixture.repository.getSiteByBaseUrl("https://edge.example.com/");
    assert.equal(edge.enabled, false);
    assert.equal(edge.credentialConfigured, false);
  } finally {
    fixture.close();
  }
});

test("site transfer rejects wrong passwords and invalid payloads before changing sites", async () => {
  const fixture = createFixture();
  try {
    const validEncryption = await encryptBackup({
      payloadType: "database-backup",
      payloadVersion: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      sites: []
    }, PASSWORD);
    await assert.rejects(
      () => fixture.service.importTransfer(validEncryption, "totally wrong password"),
      (error) => error.code === "BACKUP_DECRYPT_FAILED"
    );
    await assert.rejects(
      () => fixture.service.importTransfer(validEncryption, PASSWORD),
      (error) => error.code === "TRANSFER_PAYLOAD_INVALID"
    );
    assert.equal(fixture.repository.exportTransferSites().length, 0);
  } finally {
    fixture.close();
  }
});

test("published cross-platform vector decrypts to the documented payload", async () => {
  const vector = '{"format":"group-price-fetcher-backup","formatVersion":1,"cipher":"aes-256-gcm","kdf":{"name":"scrypt","N":32768,"r":8,"p":1,"salt":"AAECAwQFBgcICQoLDA0ODw=="},"iv":"EBESExQVFhcYGRob","tag":"wlbOj5nieCEHcy6srBmeww==","ciphertext":"o8btobKGkZjbpB3leDNxqh5Pko8TLt9I4YkPA+xufCZVRVqW7hrDSuHNMeG7dUjh3xDuy2Y9iqga+97DyUr09VihlI9xiZmGCfRnWrcJQWpxeoo25OWDj2JkJJEu4azegrdCfzh8qlgNfHjI5M85AC3uSF46aYCvXJpRj/Bh2rprlUtSnnmz1tWxYGG5DYKdmadiU8a+Z2LVaRkq0ZVzPMApFx6s4x29I67somusfd4tq7j73nC6yCLXGbbRaJGzbuj1t2mM7ez/1FuXYl4vClTjdFHxIS6OKO00vBvhLwDbhbUanntdDNGLmkrFOMb4rtMouYx+v3TFZrtOPylY4RkUXW7Hs96zoChAUOHJrOf3LzIo2fg70/bk0WS8+76rmEAmjmQ8dgfohXDmGqQ8dcenI4B6ha01eGSfjFKraNL4QjnkRayMj63GnFl8bh17bdp0i81Yehx7cKmDF0BS1u8YdXtnuq4IugzcL3r9aasdoRVgQs5OxY2RfpPeVHEkJ4d19ABRZ9080w2L"}';
  const payload = await decryptBackup(vector, "transfer-vector-password");
  assert.equal(payload.payloadType, "site-transfer");
  assert.equal(payload.sites[0].credentials.password, "vector-secret");
  assert.equal(payload.sites[0].rateConversionFactor, 0.1);
});

function createFixture(now = "2026-07-13T00:00:00.000Z") {
  const repository = createRepository();
  const credentialStore = createMemoryCredentialStore();
  const browserAdapter = {
    async readState() { return {}; },
    async writeState() {},
    async login() {},
    async close() {}
  };
  const authManager = createAuthManager({ repository, credentialStore, browserAdapter });
  const service = createSiteTransferService({
    repository,
    credentialStore,
    authManager,
    clock: () => new Date(now)
  });
  return { repository, credentialStore, authManager, service, close: () => repository.close() };
}

function createMemoryCredentialStore() {
  const entries = new Map();
  return {
    async get(reference) { return entries.has(reference) ? structuredClone(entries.get(reference)) : null; },
    async set(reference, value) { entries.set(reference, structuredClone(value)); },
    async delete(reference) { return entries.delete(reference); },
    async exportAll() { return Object.fromEntries([...entries].map(([key, value]) => [key, structuredClone(value)])); }
  };
}

function sampleCollection() {
  return {
    groups: [{
      groupId: "group-1",
      groupName: "默认组",
      platform: "openai",
      status: "active",
      baseRateMultiplier: 0.2,
      effectiveRateMultiplier: 0.2,
      peakRate: { enabled: false, multiplier: 1, effectiveMultiplier: 0.2 }
    }]
  };
}
