import test from "node:test";
import assert from "node:assert/strict";
import { getProvider, listProviders } from "../src/providerRegistry.js";

test("registry exposes only sub2api and NewAPI", () => {
  assert.deepEqual(listProviders().map((item) => item.id), ["sub2api", "newapi"]);
  assert.equal(getProvider().id, "sub2api");
  assert.throws(() => getProvider("uling-gateway"), /未知 provider/);
});
