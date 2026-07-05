// AES-256-GCM encryption with a filesystem-stored master key.
// Storage format: enc:v1:{iv_b64}:{tag_b64}:{ct_b64}
// The master key lives at ~/.nodalai/secrets.key (mode 0600 on Unix; Windows
// relies on the user's profile directory ACL being user-private by default).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedMasterKey: Buffer | null = null;

export function masterKeyPath(): string {
  return join(homedir(), '.nodalai', 'secrets.key');
}

/**
 * True when the master key file does not exist on disk yet.
 * Used by callers (I-6) to distinguish "first boot, safe to mint a new key"
 * from "key file lost/moved, but encrypted data already depends on it" —
 * a distinction this module itself can't make since it has no DB access.
 */
export function masterKeyFileMissing(path: string = masterKeyPath()): boolean {
  return !existsSync(path);
}

/**
 * Load the master key from disk, or generate + persist a new one if absent.
 * Cached after first call. Throws if the file exists but is malformed.
 */
export function loadOrCreateMasterKey(path: string = masterKeyPath()): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `secrets: master key at ${path} is malformed (expected ${KEY_BYTES} bytes, got ${buf.length})`,
      );
    }
    cachedMasterKey = buf;
    return buf;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const buf = randomBytes(KEY_BYTES);
  writeFileSync(path, buf.toString('base64'), { mode: 0o600 });
  // chmod is a no-op on Windows; the profile dir is user-private via NTFS ACL.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: ignore */
  }
  cachedMasterKey = buf;
  return buf;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`enc:${VERSION}:`);
}

export function encrypt(plaintext: string, key: Buffer = loadOrCreateMasterKey()): string {
  if (plaintext === '') return '';
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob: string, key: Buffer = loadOrCreateMasterKey()): string {
  if (blob === '') return '';
  if (!isEncrypted(blob)) {
    throw new Error('secrets: value is not encrypted (missing enc:v1: prefix)');
  }
  const parts = blob.split(':');
  if (parts.length !== 5) throw new Error('secrets: malformed ciphertext');
  const [, , ivB64, tagB64, ctB64] = parts;
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('secrets: malformed ciphertext');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf-8');
}

/** Returns the last 4 chars of a plaintext secret for UI display. */
export function last4(plaintext: string): string {
  if (plaintext.length <= 4) return plaintext;
  return plaintext.slice(-4);
}

/** Test-only: reset the cached master key so tests can swap key files. */
export function _resetMasterKeyCacheForTests(): void {
  cachedMasterKey = null;
}

/**
 * Test-only: inject a deterministic master key into the cache so tests don't
 * touch the real ~/.nodalai/secrets.key. Must be exactly 32 bytes.
 */
export function _setMasterKeyForTests(buf: Buffer): void {
  if (buf.length !== KEY_BYTES) {
    throw new Error(`secrets: test master key must be ${KEY_BYTES} bytes, got ${buf.length}`);
  }
  cachedMasterKey = buf;
}
