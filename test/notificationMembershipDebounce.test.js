import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationService } from "../src/notificationService.js";

function makeRepo() {
  return {
    getNotificationPolicy() {
      return {
        enabled: true,
        minIntervalSeconds: 0,
        eventTypes: ["group_added", "group_removed", "rate_changed", "ratio_changed"],
        fields: ["effectiveRateMultiplier"]
      };
    },
    listNotificationChannels() {
      return [{
        id: 1,
        enabled: true,
        type: "webhook",
        name: "hook",
        eventTypes: [],
        subscriptions: []
      }];
    },
    getNotificationChannelConfig() {
      return { url: "http://127.0.0.1:9/hook" };
    },
    createNotificationLog() { return { id: 1 }; },
    completeNotificationLog() {},
    getNotificationData() { return {}; }
  };
}

test("membership opposite events cancel within confirm window", async () => {
  let now = Date.parse("2026-07-18T09:31:00Z");
  const requests = [];
  const service = createNotificationService({
    repository: makeRepo(),
    credentialStore: { unlock() {}, getSecret() { return null; } },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "ok" };
    },
    clock: () => new Date(now),
    sleep: async () => {},
    groupMembershipConfirmMs: 90_000
  });

  const removed = {
    siteId: 9,
    groupId: "ChatGPTdefault",
    groupName: "ChatGPTdefault",
    changeType: "group_removed",
    oldValue: { effectiveRateMultiplier: 0.01 },
    newValue: null
  };
  const added = {
    siteId: 9,
    groupId: "ChatGPTdefault",
    groupName: "ChatGPTdefault",
    changeType: "group_added",
    oldValue: null,
    newValue: { effectiveRateMultiplier: 0.01 }
  };

  let out = await service.dispatchCollectionChanges([removed]);
  assert.equal(out.sent, 0);
  assert.equal(requests.length, 0);

  now = Date.parse("2026-07-18T09:32:00Z");
  out = await service.dispatchCollectionChanges([added]);
  assert.equal(out.sent, 0);
  assert.equal(requests.length, 0);

  await service.close();
});

test("membership events mature after confirm window if not reversed", async () => {
  let now = Date.parse("2026-07-18T09:31:00Z");
  const service = createNotificationService({
    repository: makeRepo(),
    credentialStore: { unlock() {}, getSecret() { return null; } },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "ok" }),
    clock: () => new Date(now),
    sleep: async () => {},
    groupMembershipConfirmMs: 90_000
  });

  const removed = {
    siteId: 9,
    groupId: "ChatGPTdefault",
    groupName: "ChatGPTdefault",
    changeType: "group_removed",
    oldValue: { effectiveRateMultiplier: 0.01 },
    newValue: null
  };

  const out = await service.dispatchCollectionChanges([removed]);
  assert.equal(out.sent, 0);
  assert.equal(service.flushMaturedMembershipChanges().length, 0);

  now = Date.parse("2026-07-18T09:33:00Z");
  const matured = service.flushMaturedMembershipChanges();
  assert.equal(matured.length, 1);
  assert.equal(matured[0].changeType, "group_removed");
  assert.equal(matured[0].groupName, "ChatGPTdefault");

  await service.close();
});
