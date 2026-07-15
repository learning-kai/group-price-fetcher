import test from "node:test";
import assert from "node:assert/strict";
import { fetchPrices, sub2apiProvider } from "../src/providers/sub2api.js";

test("sub2api provider combines available groups with user rates", async () => {
  const calls = [];
  const result = await fetchPrices({
    baseUrl: "https://sub2.example.com",
    token: "access-token"
  }, async ({ path, token }) => {
    calls.push({ path, token });
    if (path === "/groups/available") return [{
      id: 9,
      name: "OpenAI 专属",
      platform: "openai",
      rate_multiplier: 0.3,
      description: "普通倍率",
      status: "active"
    }];
    if (path === "/groups/rates") return { 9: 0.18 };
    if (path === "/keys") return { items: [] };
    throw new Error(`unexpected path: ${path}`);
  });

  assert.equal(sub2apiProvider.id, "sub2api");
  assert.deepEqual(calls.map((call) => call.path), ["/groups/available", "/groups/rates", "/keys", "/auth/me"]);
  assert.equal(result.providerId, "sub2api");
  assert.equal(result.groups[0].baseRateMultiplier, 0.3);
  assert.equal(result.groups[0].userRateMultiplier, 0.18);
  assert.equal(result.groups[0].effectiveRateMultiplier, 0.18);
});

test("sub2api provider prefers the active API key named 1111 when account keys have multiple rates", async () => {
  const result = await fetchPrices({
    baseUrl: "https://sub2.example.com",
    token: "access-token"
  }, async ({ path }) => {
    if (path === "/groups/available") return [
      { id: 1, name: "低倍率", rate_multiplier: 0.02, status: "active" },
      { id: 2, name: "高倍率", rate_multiplier: 0.15, status: "active" }
    ];
    if (path === "/groups/rates") return {};
    if (path === "/keys") return {
      items: [
        { id: 7, name: "other", group_id: 2, status: "active" },
        { id: 8, name: "1111", group_id: 1, status: "active" }
      ]
    };
    throw new Error(`unexpected path: ${path}`);
  });

  assert.equal(result.summary.currentRateMultiplier, 0.02);
  assert.equal(result.summary.currentRateAmbiguous, false);
  assert.equal(result.summary.currentRateCount, 1);
  assert.equal(result.summary.currentRateKeyName, "1111");
});

test("sub2api provider captures authenticated account balance without failing rate collection", async () => {
  const result = await fetchPrices({ baseUrl: "https://sub2.example.com", token: "access-token" }, async ({ path }) => {
    if (path === "/groups/available") return [{ id: 1, name: "默认", rate_multiplier: 0.1 }];
    if (path === "/groups/rates") return {};
    if (path === "/keys") return { items: [] };
    if (path === "/auth/me") return { balance: 12.345678 };
    throw new Error(`unexpected path: ${path}`);
  });
  assert.deepEqual(result.account, {
    status: "known",
    balanceUsd: 12.345678,
    source: "sub2api:auth/me",
    error: "",
    fetchedAt: result.fetchedAt
  });
});

test("sub2api provider reports the logged-in account current selected rate", async () => {
  const result = await fetchPrices({
    baseUrl: "https://sub2.example.com",
    token: "access-token"
  }, async ({ path }) => {
    if (path === "/groups/available") return [{
      id: 9,
      name: "当前分组",
      platform: "openai",
      rate_multiplier: 0.3,
      status: "active"
    }];
    if (path === "/groups/rates") return { 9: 0.18 };
    if (path === "/keys") return {
      items: [{ id: 7, name: "当前密钥", group_id: 9, status: "active" }]
    };
    throw new Error(`unexpected path: ${path}`);
  });

  assert.equal(result.summary.currentRateMultiplier, 0.18);
  assert.equal(result.summary.currentRateAmbiguous, false);
  assert.deepEqual(result.currentRates.map((item) => ({
    groupId: item.groupId,
    currentRateMultiplier: item.currentRateMultiplier
  })), [{ groupId: 9, currentRateMultiplier: 0.18 }]);
});
