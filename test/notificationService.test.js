import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createCredentialStore } from "../src/credentialStore.js";
import { createNotificationService } from "../src/notificationService.js";
import { createRepository } from "../src/storage.js";

async function fixture({ fetchImpl, smtpSend, clock = () => new Date("2026-07-14T00:00:00.000Z"), sleep, queueCapacity, onError } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-service-"));
  const repository = createRepository({ dbPath: path.join(dir, "data.db"), clock });
  const credentialStore = createCredentialStore({
    vaultPath: path.join(dir, "vault"),
    protector: {
      async protect(value) { return Buffer.from(value).toString("base64"); },
      async unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
    }
  });
  const service = createNotificationService({ repository, credentialStore, fetchImpl, smtpSend, clock, sleep, queueCapacity, onError });
  return {
    dir,
    repository,
    credentialStore,
    service,
    async cleanup() { await service.close(); repository.close(); await rm(dir, { recursive: true, force: true }); }
  };
}

test("channel CRUD separates secrets, masks metadata and preserves config on empty update", async () => {
  const f = await fixture({ fetchImpl: async () => new Response("ok") });
  try {
    const created = await f.service.createChannel({
      name: "Deploy hook",
      type: "webhook",
      enabled: true,
      subscriptions: [],
      eventTypes: ["ratio_changed"],
      config: { url: "https://hooks.example.com/secret-path", method: "POST", headers: { Authorization: "Bearer secret" } }
    });
    assert.equal(JSON.stringify(created).includes("secret-path"), false);
    assert.equal(created.configured, true);
    assert.deepEqual(created.configFields, ["headers", "method", "url"]);
    assert.deepEqual(Object.keys(await f.credentialStore.get(`notification:${created.id}`)), ["config"]);
    const updated = await f.service.updateChannel(created.id, { name: "Renamed", config: {} });
    assert.equal(updated.name, "Renamed");
    assert.equal(JSON.parse((await f.credentialStore.get(`notification:${created.id}`)).config).url.includes("secret-path"), true);
    assert.equal((await f.service.listChannels())[0].configured, true);
    assert.deepEqual((await f.service.listChannels())[0].configFields, ["headers", "method", "url"]);
    assert.equal(await f.service.deleteChannel(created.id), true);
    assert.equal(await f.credentialStore.get(`notification:${created.id}`), null);
  } finally { await f.cleanup(); }
});

test("supports Telegram, WeCom, DingTalk and Feishu text destinations", async () => {
  const calls = [];
  const clock = () => new Date("2026-07-14T00:00:00.123Z");
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    if (String(url).includes("api.telegram.org")) return Response.json({ ok: true });
    if (String(url).includes("wecom")) return Response.json({ errcode: 0 });
    if (String(url).includes("dingtalk")) return Response.json({ errcode: 0 });
    return Response.json({ code: 0 });
  };
  const f = await fixture({ fetchImpl, clock });
  try {
    const channels = [
      await f.service.createChannel({ name: "Telegram", type: "telegram", config: { botToken: "bot-secret", chatId: "123" } }),
      await f.service.createChannel({ name: "WeCom", type: "wecom", config: { webhookUrl: "https://wecom.example/hook/key-secret" } }),
      await f.service.createChannel({ name: "DingTalk", type: "dingtalk", config: { webhookUrl: "https://dingtalk.example/hook", secret: "ding-secret" } }),
      await f.service.createChannel({ name: "Feishu", type: "feishu", config: { webhookUrl: "https://feishu.example/hook", secret: "fei-secret" } })
    ];
    for (const channel of channels) await f.service.testChannel(channel.id);

    assert.equal(calls[0].url, "https://api.telegram.org/botbot-secret/sendMessage");
    assert.deepEqual(calls[0].body, { chat_id: "123", text: "通知渠道测试" });
    assert.equal("parse_mode" in calls[0].body, false);
    assert.deepEqual(calls[1].body, { msgtype: "text", text: { content: "通知渠道测试" } });

    const dingTimestamp = String(clock().getTime());
    const dingSign = createHmac("sha256", "ding-secret").update(`${dingTimestamp}\nding-secret`).digest("base64");
    const dingUrl = new URL(calls[2].url);
    assert.equal(dingUrl.searchParams.get("timestamp"), dingTimestamp);
    assert.equal(dingUrl.searchParams.get("sign"), dingSign);
    assert.deepEqual(calls[2].body, { msgtype: "text", text: { content: "通知渠道测试" } });

    const feishuTimestamp = String(Math.floor(clock().getTime() / 1000));
    const feishuSign = createHmac("sha256", `${feishuTimestamp}\nfei-secret`).update("").digest("base64");
    assert.deepEqual(calls[3].body, {
      timestamp: feishuTimestamp,
      sign: feishuSign,
      msg_type: "text",
      content: { text: "通知渠道测试" }
    });
    assert.deepEqual(channels.map((channel) => channel.configFields), [
      ["botToken", "chatId"],
      ["webhookUrl"],
      ["secret", "webhookUrl"],
      ["secret", "webhookUrl"]
    ]);
  } finally { await f.cleanup(); }
});

test("human destinations receive actionable event details instead of a generic count", async () => {
  const calls = [];
  const f = await fixture({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    }
  });
  try {
    const site = f.repository.createSite({ name: "章泓", baseUrl: "https://example.com" });
    await f.service.createChannel({
      name: "Telegram",
      type: "telegram",
      subscriptions: [site.id],
      eventTypes: ["ratio_changed", "balance_low"],
      config: { botToken: "bot-secret", chatId: "123" }
    });
    await f.service.dispatchCollectionChanges([
      {
        siteId: site.id,
        siteName: "章泓",
        groupName: "ChatGPTdefault",
        changeType: "ratio_changed",
        oldValue: 0.008,
        newValue: 0.01,
        changePercent: 25
      },
      {
        siteId: site.id,
        siteName: "章泓",
        changeType: "balance_low",
        balanceUsd: 0.46,
        balanceThresholdUsd: 1
      }
    ]);
    assert.equal(calls.length, 1);
    const text = calls[0].body.text;
    for (const expected of ["章泓", "ChatGPTdefault", "0.008", "0.01", "25", "$0.46", "$1.00"]) {
      assert.match(text, new RegExp(expected.replace("$", "\\$")));
    }
    assert.doesNotMatch(text, /^2 条变更$/);
  } finally { await f.cleanup(); }
});

test("email validates and uses injected SMTP sender without exposing configuration", async () => {
  const sent = [];
  const f = await fixture({
    fetchImpl: async () => { throw new Error("HTTP should not be used for email"); },
    smtpSend: async (config, message) => { sent.push({ config, message }); }
  });
  try {
    const channel = await f.service.createChannel({
      name: "Email",
      type: "email",
      config: {
        host: "smtp.example.com", port: 587, secure: false, useTls: true,
        username: "mailer", password: "mail-secret", from: "alerts@example.com",
        recipients: ["ops@example.com", "dev@example.com"]
      }
    });
    assert.deepEqual(channel.configFields, ["from", "host", "password", "port", "recipients", "secure", "useTls", "username"]);
    assert.equal(JSON.stringify(channel).includes("smtp.example.com"), false);
    await f.service.testChannel(channel.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].config.host, "smtp.example.com");
    assert.equal(sent[0].message.text, "通知渠道测试");
    assert.deepEqual(sent[0].message.to, ["ops@example.com", "dev@example.com"]);
  } finally { await f.cleanup(); }
});

test("validates destination-specific configuration and rejects header injection", async () => {
  const f = await fixture({ fetchImpl: async () => new Response("ok") });
  try {
    const invalid = [
      { type: "webhook", config: { url: "https://example.com", method: "PATCH" } },
      { type: "telegram", config: { botToken: "", chatId: "123" } },
      { type: "wecom", config: { webhookUrl: "ftp://example.com/hook" } },
      { type: "dingtalk", config: { webhookUrl: "https://example.com", secret: 123 } },
      { type: "feishu", config: {} },
      { type: "email", config: { host: "smtp.example.com", port: 0, from: "a@example.com", recipients: ["b@example.com"] } },
      { type: "email", config: { host: "smtp.example.com\r\nRCPT TO:<steal@example.com>", port: 25, from: "a@example.com", recipients: ["b@example.com"] } },
      { type: "email", config: { host: "smtp.example.com", port: 25, from: "a@example.com\r\nBcc: steal@example.com", recipients: ["b@example.com"] } },
      { type: "email", config: { host: "smtp.example.com", port: 25, from: "a@example.com", recipients: [] } },
      { type: "email", config: { host: "smtp.example.com", port: 25, from: "a@example.com", recipients: ["b@example.com\nDATA"] } }
    ];
    for (const [index, input] of invalid.entries()) {
      await assert.rejects(() => f.service.createChannel({ name: `Invalid ${index}`, ...input }));
    }
  } finally { await f.cleanup(); }
});

test("HTTP destinations use a 10 second AbortController timeout", async (t) => {
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (_callback, delay) => {
    delays.push(delay);
    return { unref() {} };
  });
  let signal;
  const f = await fixture({
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Response("ok");
    }
  });
  try {
    const channel = await f.service.createChannel({ name: "Timeout", type: "webhook", config: { url: "https://example.com/hook" } });
    await f.service.testChannel(channel.id);
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(delays.includes(10_000), true);
  } finally { await f.cleanup(); }
});

test("send failures and logs mask URLs, tokens, credentials and response bodies", async () => {
  const leaked = "https://api.telegram.org/botbot-secret/sendMessage response-body-secret";
  const f = await fixture({ fetchImpl: async () => { throw new Error(leaked); }, sleep: async () => {} });
  try {
    const channel = await f.service.createChannel({
      name: "Masked", type: "telegram", config: { botToken: "bot-secret", chatId: "private-chat" }
    });
    await assert.rejects(
      () => f.service.testChannel(channel.id),
      (error) => !error.message.includes("bot-secret") && !error.message.includes("response-body-secret")
    );
    const logs = await f.service.listLogs({ channelId: channel.id });
    const serialized = JSON.stringify(logs);
    for (const secret of ["bot-secret", "private-chat", "response-body-secret", "api.telegram.org"]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally { await f.cleanup(); }
});

test("test send records a log without config values", async () => {
  const calls = [];
  const f = await fixture({ fetchImpl: async (url, options) => { calls.push([url, options]); return new Response("ok", { status: 200 }); } });
  try {
    const channel = await f.service.createChannel({
      name: "Test hook", type: "webhook", config: { url: "https://hooks.example.com/top-secret", method: "PUT" }
    });
    const result = await f.service.testChannel(channel.id);
    assert.equal(result.status, "sent");
    assert.equal(calls[0][1].method, "PUT");
    const logs = await f.service.listLogs({ channelId: channel.id });
    assert.equal(logs.items.length, 1);
    assert.equal(JSON.stringify(logs).includes("top-secret"), false);
  } finally { await f.cleanup(); }
});

test("dispatch batches eligible rate changes while membership changes await confirmation", async () => {
  const payloads = [];
  let now = new Date("2026-07-14T00:00:00.000Z");
  const f = await fixture({
    clock: () => now,
    fetchImpl: async (_url, options) => { payloads.push(JSON.parse(options.body)); return new Response("ok"); }
  });
  try {
    const site = f.repository.createSite({ name: "A", baseUrl: "https://a.example.com" });
    await f.service.createChannel({
      name: "Filtered", type: "webhook", subscriptions: [site.id], eventTypes: ["ratio_changed", "group_added", "group_removed"],
      config: { url: "https://hooks.example.com/notify", method: "POST" }
    });
    f.repository.setNotificationPolicy({
      minRatioChangePercent: 5, balanceCooldownHours: 24, failureCooldownMinutes: 60, retryAttempts: 3
    });
    const changes = [
      { siteId: site.id, siteName: "A", changeType: "ratio_changed", changePercent: 3, message: "small" },
      { siteId: site.id, siteName: "A", changeType: "ratio_changed", changePercent: 10, message: "large" },
      { siteId: site.id, siteName: "A", changeType: "group_added", message: "added" },
      { siteId: 99, siteName: "B", changeType: "ratio_changed", changePercent: 20, message: "other site" },
      { siteId: site.id, siteName: "A", changeType: "status_changed", message: "wrong event" }
    ];
    assert.equal((await f.service.dispatchCollectionChanges(changes)).sent, 1);
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0].changes.map((change) => change.changeType), ["ratio_changed"]);
    assert.equal((await f.service.dispatchCollectionChanges(changes)).sent, 1);
    assert.equal(payloads.length, 2);
  } finally { await f.cleanup(); }
});

test("persistent cooldown applies only to balance and final failure events by site and event", async () => {
  const payloads = [];
  let now = new Date("2026-07-14T00:00:00.000Z");
  const f = await fixture({
    clock: () => now,
    fetchImpl: async (_url, options) => { payloads.push(JSON.parse(options.body)); return new Response("ok"); }
  });
  try {
    const site = f.repository.createSite({ name: "A", baseUrl: "https://a.example.com" });
    await f.service.createChannel({
      name: "All events", type: "webhook", subscriptions: [site.id],
      eventTypes: ["ratio_changed", "group_added", "group_removed", "balance_low", "auth_failed", "collection_failed"],
      config: { url: "https://hooks.example.com/notify" }
    });
    f.repository.setNotificationPolicy({
      minRatioChangePercent: 0, balanceCooldownHours: 24, failureCooldownMinutes: 60, retryAttempts: 3
    });
    const special = [
      { siteId: site.id, siteName: "A", changeType: "balance_low", balanceUsd: 1 },
      { siteId: site.id, siteName: "A", changeType: "auth_failed" },
      { siteId: site.id, siteName: "A", changeType: "collection_failed" }
    ];
    assert.equal((await f.service.dispatchCollectionChanges(special)).sent, 1);
    assert.equal((await f.service.dispatchCollectionChanges(special)).sent, 0);
    now = new Date("2026-07-14T01:01:00.000Z");
    assert.equal((await f.service.dispatchCollectionChanges(special)).sent, 1);
    assert.deepEqual(payloads.at(-1).changes.map((change) => change.changeType), ["auth_failed", "collection_failed"]);
    now = new Date("2026-07-15T00:01:00.000Z");
    assert.equal((await f.service.dispatchCollectionChanges(special)).sent, 1);
    assert.deepEqual(payloads.at(-1).changes.map((change) => change.changeType), ["balance_low", "auth_failed", "collection_failed"]);
  } finally { await f.cleanup(); }
});

test("enqueue methods are bounded, return immediately and close drains queued work", async () => {
  let release;
  let started = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture({
    queueCapacity: 2,
    fetchImpl: async () => { started = true; await pending; return new Response("ok"); }
  });
  const site = f.repository.createSite({ name: "A", baseUrl: "https://a.example.com" });
  await f.service.createChannel({ name: "Queue", type: "webhook", config: { url: "https://hooks.example.com/notify" } });
  const change = { siteId: site.id, siteName: "A", changeType: "ratio_changed", changePercent: 10 };

  assert.equal(f.service.enqueueCollectionChanges([change]), true);
  assert.equal(f.service.enqueueEvent({ ...change, changeType: "group_added" }), true);
  assert.equal(f.service.enqueueEvent({ ...change, changeType: "group_removed" }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  const closing = f.service.close();
  let closed = false;
  closing.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  f.repository.close();
  await rm(f.dir, { recursive: true, force: true });
});

test("transient failures honor retryAttempts while permanent 4xx does not retry", async () => {
  let transientCalls = 0;
  const f = await fixture({
    sleep: async () => {},
    fetchImpl: async () => {
      transientCalls += 1;
      return new Response("unavailable", { status: transientCalls < 3 ? 503 : 200 });
    }
  });
  try {
    const channel = await f.service.createChannel({ name: "Retry", type: "webhook", config: { url: "https://hooks.example.com/a" } });
    f.repository.setNotificationPolicy({ minRatioChangePercent: 0, balanceCooldownHours: 24, failureCooldownMinutes: 60, retryAttempts: 2 });
    await assert.rejects(() => f.service.testChannel(channel.id));
    assert.equal(transientCalls, 2);
  } finally { await f.cleanup(); }

  let permanentCalls = 0;
  const p = await fixture({ fetchImpl: async () => { permanentCalls += 1; return new Response("bad", { status: 400 }); }, sleep: async () => {} });
  try {
    const channel = await p.service.createChannel({ name: "No retry", type: "webhook", config: { url: "https://hooks.example.com/b" } });
    await assert.rejects(() => p.service.testChannel(channel.id), (error) => error.status === 400);
    assert.equal(permanentCalls, 1);
    assert.equal((await p.service.listLogs({ channelId: channel.id })).items[0].attempts, 1);
  } finally { await p.cleanup(); }
});
