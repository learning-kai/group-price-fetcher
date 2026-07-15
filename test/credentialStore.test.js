import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCredentialStore,
  createLinuxAesGcmProtector,
  createPlatformProtector
} from "../src/credentialStore.js";

test("Linux AES-GCM protector round-trips without plaintext and rejects a wrong key", async () => {
  const key = "11".repeat(32);
  const protector = createLinuxAesGcmProtector({ key });
  const encrypted = await protector.protect('{"password":"server-secret"}');

  assert.match(encrypted, /^linux-aes-256-gcm:v1:/);
  assert.equal(encrypted.includes("server-secret"), false);
  assert.equal(await protector.unprotect(encrypted), '{"password":"server-secret"}');
  await assert.rejects(
    () => createLinuxAesGcmProtector({ key: "22".repeat(32) }).unprotect(encrypted),
    /密钥不匹配|已损坏/
  );
  assert.throws(() => createLinuxAesGcmProtector({ key: "short" }), /32 字节/);
});

test("platform protector selects the portable server vault on Linux", async () => {
  const protector = createPlatformProtector({ platform: "linux", key: "33".repeat(32) });
  const encrypted = await protector.protect("portable");
  assert.equal(await protector.unprotect(encrypted), "portable");
});

test("credential store encrypts values at rest and supports its full lifecycle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-credentials-"));
  const vaultPath = path.join(dir, "credentials.vault");
  const protector = {
    async protect(plainText) {
      return `protected:${Buffer.from(plainText).toString("base64")}`;
    },
    async unprotect(cipherText) {
      assert.match(cipherText, /^protected:/);
      return Buffer.from(cipherText.slice("protected:".length), "base64").toString("utf8");
    }
  };
  const store = createCredentialStore({ vaultPath, protector });

  try {
    assert.equal(await store.has("site:7"), false);
    await store.set("site:7", { email: "user@example.com", password: "plain-secret" });

    assert.equal(await store.has("site:7"), true);
    assert.deepEqual(await store.get("site:7"), {
      email: "user@example.com",
      password: "plain-secret"
    });
    const persisted = await readFile(vaultPath, "utf8");
    assert.equal(persisted.includes("plain-secret"), false);
    assert.equal(persisted.includes("user@example.com"), false);

    assert.equal(await store.delete("site:7"), true);
    assert.equal(await store.get("site:7"), null);
    assert.equal(await store.delete("site:7"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential store serializes concurrent updates without losing entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-credentials-"));
  const vaultPath = path.join(dir, "credentials.vault");
  const protector = {
    async protect(value) { return Buffer.from(value).toString("base64"); },
    async unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
  };
  const store = createCredentialStore({ vaultPath, protector });

  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.set(`site:${index}`, { password: `secret-${index}` })
    )));
    const values = await Promise.all(Array.from({ length: 12 }, (_, index) => store.get(`site:${index}`)));
    assert.deepEqual(values.map((value) => value.password), Array.from({ length: 12 }, (_, index) => `secret-${index}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential store exports defensive copies and replaces the complete vault", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-credentials-"));
  const vaultPath = path.join(dir, "credentials.vault");
  const protector = {
    async protect(value) { return Buffer.from(value).toString("base64"); },
    async unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
  };
  const store = createCredentialStore({ vaultPath, protector });

  try {
    await store.set("site:1", { email: "one@example.com", password: "secret-one" });
    const entries = await store.exportAll();
    entries["site:1"].password = "mutated";
    assert.equal((await store.get("site:1")).password, "secret-one");

    await store.replaceAll({ "site:2": { accessToken: "token-two", userId: "2" } });
    assert.equal(await store.get("site:1"), null);
    assert.deepEqual(await store.get("site:2"), { accessToken: "token-two", userId: "2" });
    await assert.rejects(() => store.replaceAll({ invalid: { password: "value" } }), /凭据引用无效/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential store accepts positive notification references while preserving string-only values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "group-price-credentials-"));
  const vaultPath = path.join(dir, "credentials.vault");
  const protector = {
    async protect(value) { return Buffer.from(value).toString("base64"); },
    async unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
  };
  const store = createCredentialStore({ vaultPath, protector });

  try {
    await store.set("notification:2", { config: JSON.stringify({ token: "secret" }) });
    assert.deepEqual(await store.get("notification:2"), { config: '{"token":"secret"}' });
    await assert.rejects(() => store.set("notification:0", { config: "{}" }), /凭据引用无效/);
    await assert.rejects(() => store.set("notification:1", { config: {} }), /字符串/);
    await store.replaceAll({
      "site:1": { accessToken: "old-compatible-token", userId: "1" },
      "notification:3": { config: "{}" }
    });
    assert.equal((await store.exportAll())["site:1"].accessToken, "old-compatible-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
