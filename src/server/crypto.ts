import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM. Ciphertext format: `<keyId>:<iv b64url>:<tag b64url>:<data b64url>`.
 * The key-ID prefix allows rotation: add the old key to LEGACY keys and re-encrypt lazily.
 */
function keyFor(id: string): Buffer {
  if (id === env.ENCRYPTION_KEY_ID) return Buffer.from(env.ENCRYPTION_KEY, "base64");
  const legacy = process.env[`ENCRYPTION_KEY_${id.toUpperCase()}`];
  if (!legacy) throw new Error(`Unknown encryption key id "${id}"`);
  return Buffer.from(legacy, "base64");
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(env.ENCRYPTION_KEY_ID), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [env.ENCRYPTION_KEY_ID, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decrypt(payload: string): string {
  const [id, iv, tag, data] = payload.split(":");
  if (!id || !iv || !tag || !data) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(id), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
