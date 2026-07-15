import test from "node:test";
import assert from "node:assert/strict";
import { createExternalApiAuth } from "../src/apiKeyAuth.js";

test("external API allows loopback and requires a valid key for LAN clients", () => {
  let storedHash = "";
  const auth = createExternalApiAuth({
    getHash: () => storedHash,
    setHash: (value) => { storedHash = value; }
  });

  assert.doesNotThrow(() => auth.authorize({ remoteAddress: "127.0.0.1", headers: {} }));
  assert.throws(
    () => auth.authorize({ remoteAddress: "192.168.1.20", headers: {} }),
    (error) => error.status === 403 && error.code === "API_KEY_NOT_CONFIGURED"
  );

  const rawKey = auth.rotateKey();
  assert.equal(rawKey.length >= 40, true);
  assert.equal(storedHash.includes(rawKey), false);
  assert.throws(
    () => auth.authorize({ remoteAddress: "192.168.1.20", headers: { authorization: "Bearer wrong" } }),
    (error) => error.status === 401 && error.code === "API_KEY_INVALID"
  );
  assert.doesNotThrow(() => auth.authorize({
    remoteAddress: "::ffff:192.168.1.20",
    headers: { authorization: `Bearer ${rawKey}` }
  }));
});

test("management API rejects non-loopback clients", () => {
  const auth = createExternalApiAuth({ getHash: () => "", setHash() {} });
  assert.doesNotThrow(() => auth.authorizeManagement({ remoteAddress: "::1" }));
  assert.throws(
    () => auth.authorizeManagement({ remoteAddress: "10.0.0.8" }),
    (error) => error.status === 403 && error.code === "MANAGEMENT_LOCAL_ONLY"
  );
});
