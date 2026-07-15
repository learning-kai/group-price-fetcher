import test from "node:test";
import assert from "node:assert/strict";
import { decryptBackup, encryptBackup } from "../src/backupCrypto.js";

const payload = {
  payloadVersion: 1,
  createdAt: "2026-07-13T00:00:00.000Z",
  database: {
    encoding: "base64",
    sha256: "a".repeat(64),
    content: Buffer.from("SQLite format 3\0fixture").toString("base64")
  },
  credentials: {
    "site:1": { email: "user@example.com", password: "plain-secret" }
  }
};

test("encrypted backup round-trips without plaintext", async () => {
  const encrypted = await encryptBackup(payload, "correct horse battery staple");

  assert.deepEqual(await decryptBackup(encrypted, "correct horse battery staple"), payload);
  assert.equal(encrypted.includes("plain-secret"), false);
  assert.equal(encrypted.includes("user@example.com"), false);
  assert.equal(encrypted.includes("SQLite format 3"), false);
  const envelope = JSON.parse(encrypted);
  assert.equal(envelope.format, "group-price-fetcher-backup");
  assert.deepEqual(envelope.kdf, {
    name: "scrypt",
    N: 32768,
    r: 8,
    p: 1,
    salt: envelope.kdf.salt
  });
});

test("wrong password and ciphertext tampering are rejected", async () => {
  const encrypted = await encryptBackup(payload, "correct horse battery staple");
  await assert.rejects(
    () => decryptBackup(encrypted, "totally wrong password"),
    (error) => error.code === "BACKUP_DECRYPT_FAILED" && /密码错误或备份已损坏/.test(error.message)
  );

  const envelope = JSON.parse(encrypted);
  const replacement = envelope.ciphertext[0] === "A" ? "B" : "A";
  envelope.ciphertext = `${replacement}${envelope.ciphertext.slice(1)}`;
  await assert.rejects(
    () => decryptBackup(JSON.stringify(envelope), "correct horse battery staple"),
    (error) => error.code === "BACKUP_DECRYPT_FAILED"
  );
});

test("malformed envelopes and weak passwords are rejected before decryption", async () => {
  await assert.rejects(() => encryptBackup(payload, "short"), /至少 10 个字符/);
  await assert.rejects(
    () => decryptBackup(JSON.stringify({ format: "other", formatVersion: 1 }), "long enough password"),
    (error) => error.code === "BACKUP_FORMAT_INVALID"
  );
});
