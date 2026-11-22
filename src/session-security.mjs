import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const configuredKey = process.env.SESSION_ENCRYPTION_KEY;
const key = configuredKey && Buffer.from(configuredKey, "base64url");
if (configuredKey && (key.length !== 32 || key.toString("base64url") !== configuredKey)) {
  throw new Error("SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64url.");
}
export const sessionEncryptionEnabled = Boolean(key);
const prefix = "v1.";

export function sealSessionToken(token, id, field) {
  if (!key || token == null) return token;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(id + ":" + field));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function readSessionToken(value, id, field) {
  if (value == null || !value.startsWith(prefix)) return value;
  if (!key) throw new Error("The session encryption key is unavailable.");
  const bytes = Buffer.from(value.slice(prefix.length), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(id + ":" + field));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
