import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credential encryption at rest (DESIGN.md §9).
 *
 * Secrets (connection strings, Atlas private keys) are encrypted with
 * AES-256-GCM before being written to disk. The key is derived from
 * `PS_AGENT_SECRET_KEY` if set, otherwise from a locally-generated key file
 * (0600) under the data dir. Values are stored as `enc:v1:<iv>:<tag>:<ct>`
 * (base64 parts) so we can detect and transparently read legacy plaintext.
 */
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  const dir = process.env.PS_AGENT_DATA_DIR ?? join(homedir(), ".ps-agent");
  return join(dir, "secret.key");
}

/** Resolve the 32-byte encryption key (env var preferred, else key file). */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.PS_AGENT_SECRET_KEY;
  if (envKey) {
    // Derive a stable 32-byte key from the passphrase.
    cachedKey = scryptSync(envKey, "ps-agent-salt-v1", 32);
    return cachedKey;
  }

  const path = keyFilePath();
  if (existsSync(path)) {
    cachedKey = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    return cachedKey;
  }

  // Generate and persist a new key (0600).
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  cachedKey = key;
  return key;
}

/** Encrypt a plaintext string. Returns the `enc:v1:` envelope. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":")
  );
}

/** True if a value is an encrypted envelope produced by encryptSecret. */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Decrypt an envelope. If the value is NOT encrypted (legacy plaintext), it is
 * returned as-is so existing stores keep working and get re-encrypted on next
 * write.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const body = value.slice(PREFIX.length);
  const [ivB64, tagB64, ctB64] = body.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

/** For tests: reset the cached key so a new env/key file takes effect. */
export function _resetKeyCache(): void {
  cachedKey = null;
}
