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
  assert.deepEqual(calls.map((call) => call.path), ["/groups/available", "/groups/rates", "/keys"]);
  assert.equal(result.providerId, "sub2api");
  assert.equal(result.groups[0].baseRateMultiplier, 0.3);
  assert.equal(result.groups[0].userRateMultiplier, 0.18);
  assert.equal(result.groups[0].effectiveRateMultiplier, 0.18);
});
