import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/httpClient.js";
import { fetchPrices, newApiProvider } from "../src/providers/newApi.js";

test("NewAPI provider collects public group ratios", async () => {
  const calls = [];
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers: {} }, async (request) => {
    calls.push(request);
    return {
      success: true,
      data: {
        default: { ratio: 1, desc: "默认分组" },
        vip: { ratio: "0.25", desc: "会员分组" }
      }
    };
  });

  assert.equal(newApiProvider.id, "newapi");
  assert.deepEqual(calls.map((call) => call.path), ["/api/user/groups"]);
  assert.deepEqual(result.groups.map((group) => [group.groupName, group.effectiveRateMultiplier]), [
    ["default", 1],
    ["vip", 0.25]
  ]);
  assert.equal(result.mode, "public");
});

test("NewAPI authenticated collection derives current rate from active API key named 1111", async () => {
  const calls = [];
  const headers = { Authorization: "system-token", "New-Api-User": "123" };
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers }, async (request) => {
    calls.push(request.path);
    if (request.path === "/api/user/self/groups") {
      return { success: true, data: {
        default: { ratio: 1, desc: "默认分组" },
        vip: { ratio: 0.1, desc: "会员分组" }
      } };
    }
    if (request.path === "/api/token/?p=1&size=100") {
      return { success: true, data: { items: [
        { id: 1, name: "other", group: "default", status: 1 },
        { id: 2, name: "1111", group: "vip", status: 1 }
      ] } };
    }
    throw new Error(`unexpected path: ${request.path}`);
  });

  assert.deepEqual(calls, ["/api/user/self/groups", "/api/token/?p=1&size=100", "/api/user/self", "/api/status"]);
  assert.equal(result.summary.currentRateMultiplier, 0.1);
  assert.equal(result.summary.currentRateAmbiguous, false);
  assert.equal(result.summary.currentRateCount, 1);
  assert.equal(result.summary.currentRateKeyName, "1111");
  assert.equal(result.summary.currentRatesByFamily.gpt.currentRateMultiplier, 0.1);
  assert.equal(result.summary.currentRatesByFamily.gpt.currentRateKeyName, "1111");
});

test("NewAPI separates GPT key 1111 and Grok key named grok for current account rates", async () => {
  const headers = { Authorization: "system-token", "New-Api-User": "123" };
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers }, async ({ path }) => {
    if (path === "/api/user/self/groups") {
      return { success: true, data: {
        default: { ratio: 1, desc: "默认分组" },
        vip: { ratio: 0.1, desc: "GPT 身份分组" },
        cheap_grok: { ratio: 0.001, desc: "Grok 特价" },
        "福利Grok": { ratio: 0.002, desc: "另一个 Grok 分组" }
      } };
    }
    if (path === "/api/token/?p=1&size=100") {
      return { success: true, data: { items: [
        { id: 1, name: "other", group: "default", status: 1 },
        { id: 2, name: "1111", group: "vip", status: 1 },
        { id: 3, name: "grok", group: "cheap_grok", status: 1 },
        { id: 4, name: "grok-old", group: "福利Grok", status: 1 }
      ] } };
    }
    if (path === "/api/user/self") return { success: true, data: { quota: 500_000 } };
    if (path === "/api/status") return { success: true, data: { quota_per_unit: 500_000 } };
    throw new Error(`unexpected path: ${path}`);
  });

  assert.equal(result.summary.currentRatesByFamily.gpt.currentRateMultiplier, 0.1);
  assert.equal(result.summary.currentRatesByFamily.gpt.currentRateKeyName, "1111");
  assert.equal(result.summary.currentRatesByFamily.gpt.currentRateAmbiguous, false);
  assert.equal(result.summary.currentRatesByFamily.grok.currentRateMultiplier, 0.001);
  assert.equal(result.summary.currentRatesByFamily.grok.currentRateKeyName, "grok");
  assert.equal(result.summary.currentRatesByFamily.grok.currentRateGroupName, "cheap_grok");
  assert.equal(result.summary.currentRatesByFamily.grok.currentRateAmbiguous, false);
  // Legacy site-level current rate remains the GPT pricing identity.
  assert.equal(result.summary.currentRateMultiplier, 0.1);
  // Only pricing-identity keys are kept for current-rate derivation.
  assert.deepEqual(result.keys.map((key) => key.name).sort(), ["1111", "grok"]);
});

test("NewAPI authenticated collection prefers self groups and preserves auth headers", async () => {
  const calls = [];
  const headers = { Authorization: "system-token", "New-Api-User": "123" };
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers }, async (request) => {
    calls.push(request);
    return { success: true, data: { private: { ratio: 0.1, desc: "认证分组" } } };
  });

  assert.deepEqual(calls.map((call) => call.path), ["/api/user/self/groups", "/api/token/?p=1&size=100", "/api/user/self", "/api/status"]);
  assert.deepEqual(calls[0].headers, headers);
  assert.equal(result.mode, "authenticated");
  assert.equal(result.groups[0].groupName, "private");
});

test("NewAPI authenticated collection falls back to user groups", async () => {
  const calls = [];
  const result = await fetchPrices({
    baseUrl: "https://newapi.example.com",
    headers: { Authorization: "system-token", "New-Api-User": "123" }
  }, async ({ path }) => {
    calls.push(path);
    if (path === "/api/user/self/groups") throw new ApiError("not found", { status: 404 });
    return { success: true, data: { fallback: { ratio: 0.2 } } };
  });

  assert.deepEqual(calls, ["/api/user/self/groups", "/api/user/groups", "/api/token/?p=1&size=100", "/api/user/self", "/api/status"]);
  assert.equal(result.groups[0].effectiveRateMultiplier, 0.2);
});

test("NewAPI authenticated collection converts user quota to USD balance", async () => {
  const headers = { Authorization: "system-token", "New-Api-User": "123" };
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers }, async ({ path }) => {
    if (path === "/api/user/self/groups") return { success: true, data: { default: { ratio: 1 } } };
    if (path === "/api/token/?p=1&size=100") return { success: true, data: { items: [] } };
    if (path === "/api/user/self") return { success: true, data: { quota: 1_250_000, used_quota: 500_000 } };
    if (path === "/api/status") return { success: true, data: { quota_per_unit: 500_000 } };
    throw new Error(`unexpected path: ${path}`);
  });
  assert.deepEqual(result.account, {
    status: "known",
    balanceUsd: 2.5,
    source: "newapi:user-self",
    error: "",
    fetchedAt: result.fetchedAt
  });
});

test("NewAPI rejects success=false instead of silently saving an empty baseline", async () => {
  await assert.rejects(
    () => fetchPrices({ baseUrl: "https://newapi.example.com", headers: {} }, async () => ({
      success: false,
      message: "not allowed"
    })),
    (error) => error instanceof ApiError && error.code === "NEWAPI_RESPONSE_FAILED"
  );
});
