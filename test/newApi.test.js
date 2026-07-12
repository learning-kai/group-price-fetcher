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

test("NewAPI authenticated collection prefers self groups and preserves auth headers", async () => {
  const calls = [];
  const headers = { Authorization: "system-token", "New-Api-User": "123" };
  const result = await fetchPrices({ baseUrl: "https://newapi.example.com", headers }, async (request) => {
    calls.push(request);
    return { success: true, data: { private: { ratio: 0.1, desc: "认证分组" } } };
  });

  assert.deepEqual(calls.map((call) => call.path), ["/api/user/self/groups"]);
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

  assert.deepEqual(calls, ["/api/user/self/groups", "/api/user/groups"]);
  assert.equal(result.groups[0].effectiveRateMultiplier, 0.2);
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
