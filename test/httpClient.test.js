import assert from "node:assert/strict";
import test from "node:test";

import { createSelectiveProxyFetch } from "../src/httpClient.js";

test("only configured upstream hosts use the proxy dispatcher", async () => {
  const calls = [];
  const dispatcher = { kind: "proxy" };
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return { ok: true };
  };

  const selectiveFetch = createSelectiveProxyFetch({
    fetchImpl,
    proxyUrl: "http://127.0.0.1:7890",
    proxyHosts: "sub.kedaya.xyz",
    proxyAgentFactory: () => dispatcher
  });

  await selectiveFetch("https://sub.kedaya.xyz/api/v1/groups");
  await selectiveFetch("https://hubway.cc/api/v1/groups");

  assert.equal(calls[0].init.dispatcher, dispatcher);
  assert.equal(Object.hasOwn(calls[1].init, "dispatcher"), false);
});

test("proxy hosts use a dedicated fetch implementation", async () => {
  const directCalls = [];
  const proxyCalls = [];
  const fetchImpl = async (input) => {
    directCalls.push(String(input));
    return { ok: true };
  };
  const proxyFetchImpl = async (input) => {
    proxyCalls.push(String(input));
    return { ok: true };
  };

  const selectiveFetch = createSelectiveProxyFetch({
    fetchImpl,
    proxyFetchImpl,
    proxyUrl: "http://127.0.0.1:7890",
    proxyHosts: "sub.kedaya.xyz",
    proxyAgentFactory: () => ({ kind: "proxy" })
  });

  await selectiveFetch("https://sub.kedaya.xyz/api/v1/groups");
  await selectiveFetch("https://hubway.cc/api/v1/groups");

  assert.deepEqual(proxyCalls, ["https://sub.kedaya.xyz/api/v1/groups"]);
  assert.deepEqual(directCalls, ["https://hubway.cc/api/v1/groups"]);
});
