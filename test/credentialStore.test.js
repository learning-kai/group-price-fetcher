import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCredentialStore } from "../src/credentialStore.js";

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
