import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const FORMAT = "group-price-fetcher-backup";
const FORMAT_VERSION = 1;
const CIPHER = "aes-256-gcm";
const AAD = Buffer.from(`${FORMAT}:v${FORMAT_VERSION}`, "utf8");
const KDF = Object.freeze({ N: 32768, r: 8, p: 1 });
const SCRYPT_OPTIONS = Object.freeze({ ...KDF, maxmem: 64 * 1024 * 1024 });

export async function encryptBackup(payload, password, options = {}) {
  validatePassword(password);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw backupError("备份载荷无效", "BACKUP_PAYLOAD_INVALID");
  }
  const random = options.randomBytesImpl ?? randomBytes;
  const salt = random(16);
  const iv = random(12);
  const key = await deriveKey(password, salt, options.scryptImpl);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    cipher: CIPHER,
    kdf: {
      name: "scrypt",
      ...KDF,
      salt: salt.toString("base64")
    },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  });
}

export async function decryptBackup(serialized, password, options = {}) {
  validatePassword(password);
  const envelope = parseEnvelope(serialized);
  const salt = decodeBase64(envelope.kdf.salt, "salt", 16);
  const iv = decodeBase64(envelope.iv, "iv", 12);
  const tag = decodeBase64(envelope.tag, "tag", 16);
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  if (ciphertext.length === 0) throw backupError("备份格式无效：ciphertext", "BACKUP_FORMAT_INVALID");

  try {
    const key = await deriveKey(password, salt, options.scryptImpl);
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plainText);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid payload");
    return payload;
  } catch (error) {
    if (error?.code === "BACKUP_PASSWORD_INVALID") throw error;
    throw backupError("密码错误或备份已损坏", "BACKUP_DECRYPT_FAILED");
  }
}

async function deriveKey(password, salt, scryptImpl = scrypt) {
  const key = await scryptImpl(password, salt, 32, SCRYPT_OPTIONS);
  return Buffer.from(key);
}

function parseEnvelope(serialized) {
  let envelope;
  try {
    const text = Buffer.isBuffer(serialized) ? serialized.toString("utf8") : String(serialized);
    envelope = JSON.parse(text);
  } catch {
    throw backupError("备份格式无效：不是合法 JSON", "BACKUP_FORMAT_INVALID");
  }
  const valid = envelope
    && typeof envelope === "object"
    && !Array.isArray(envelope)
    && envelope.format === FORMAT
    && envelope.formatVersion === FORMAT_VERSION
    && envelope.cipher === CIPHER
    && envelope.kdf?.name === "scrypt"
    && envelope.kdf.N === KDF.N
    && envelope.kdf.r === KDF.r
    && envelope.kdf.p === KDF.p;
  if (!valid) throw backupError("备份格式或版本不受支持", "BACKUP_FORMAT_INVALID");
  return envelope;
}

function decodeBase64(value, label, expectedLength = null) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw backupError(`备份格式无效：${label}`, "BACKUP_FORMAT_INVALID");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value || (expectedLength !== null && buffer.length !== expectedLength)) {
    throw backupError(`备份格式无效：${label}`, "BACKUP_FORMAT_INVALID");
  }
  return buffer;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    throw backupError("备份密码至少 10 个字符", "BACKUP_PASSWORD_INVALID");
  }
}

function backupError(message, code) {
  return Object.assign(new Error(message), { code });
}
