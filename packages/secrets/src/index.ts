// AES-256-GCM encryption with a filesystem-stored master key.
// Storage format: enc:v1:{iv_b64}:{tag_b64}:{ct_b64}
// The master key lives at <Nodal home>/secrets.key — NODALAI_HOME, or ~/.nodalai
// (packages/shared/src/nodal-home.ts) — (mode 0600 on Unix; Windows
// relies on the user's profile directory ACL being user-private by default).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openNodalHome } from '@nodal-agents/shared/nodal-instances';
import {
  StateFileError,
  createStateFile,
  masterKeyFilePath,
  readStateFile,
  restrictFileToOwner as restrictStateFileToOwner,
  type StateFileSpec,
} from '@nodal-agents/shared/state-files';

/**
 * Restrict a secret file to its owner on ALL platforms (FA-5, audit sécu
 * 2026-07-07). The rule lives with the other state-file rules
 * (`@nodal-agents/shared/state-files`); re-exported here for callers that
 * already import it from this package.
 */
export function restrictFileToOwner(path: string): void {
  restrictStateFileToOwner(path);
}

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedMasterKey: Buffer | null = null;

export function masterKeyPath(): string {
  return masterKeyFilePath();
}

/**
 * The master key file, as `state-files.ts` reads and creates it. It is created
 * once and never replaced (a new key cannot read what the old one encrypted),
 * so it keeps no last good copy: the recovery is the original file.
 */
export const MASTER_KEY_FILE: StateFileSpec<Buffer> = {
  label: 'The master key file',
  parse: (text) => {
    const buf = Buffer.from(text.trim(), 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`malformed (expected ${KEY_BYTES} bytes of base64, got ${buf.length})`);
    }
    return buf;
  },
  keepsLastGood: false,
  recovery:
    'Every stored credential is encrypted with this key. Put back the original secrets.key, ' +
    'from this machine or from the backup it came from. Do not delete it: a new key cannot ' +
    'read what this one encrypted.',
};

/**
 * True when the master key file does not exist on disk yet.
 * Used by callers (I-6) to distinguish "first boot, safe to mint a new key"
 * from "key file lost/moved, but encrypted data already depends on it" —
 * a distinction this module itself can't make since it has no DB access.
 * A file that exists but cannot be read throws: it is not "missing".
 */
export function masterKeyFileMissing(path: string = masterKeyPath()): boolean {
  return readMasterKeyFile(path) === null;
}

/**
 * The key in the file at `path`, or null when there is no file. Never cached,
 * never created. Throws `StateFileError` when the file exists but is unusable.
 */
export function readMasterKeyFile(path: string = masterKeyPath()): Buffer | null {
  return readStateFile(path, MASTER_KEY_FILE);
}

/**
 * Load the master key from disk, or generate + persist a new one if absent.
 * Cached after first call. Throws if the file exists but is malformed.
 *
 * Creation is exclusive and atomic (`createStateFile`): the runner and the
 * dashboard can both reach this on a first start, and two keys minted at once
 * would leave one process encrypting with a key no file holds. The loser of
 * that race reads the winner's key.
 */
export function loadOrCreateMasterKey(path: string = masterKeyPath()): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  cachedMasterKey = readMasterKeyFile(path) ?? createMasterKeyFile(path);
  return cachedMasterKey;
}

/**
 * Create the master key file at `path` and return the key in it. Never
 * cached. When another process created the file first, returns THEIR key,
 * read back from the file.
 */
export function createMasterKeyFile(path: string = masterKeyPath()): Buffer {
  // The key of an instance comes into existence here: the instance is declared
  // in the registry first (openNodalHome), so the sandbox of every other
  // instance refuses this file from its first byte. A key written at another
  // path (an explicit path, as tests do) belongs to no instance.
  if (path === masterKeyPath()) openNodalHome();
  const buf = randomBytes(KEY_BYTES);
  try {
    createStateFile(path, buf.toString('base64'), MASTER_KEY_FILE);
    return buf;
  } catch (err) {
    if (err instanceof StateFileError && err.code === 'STATE_FILE_EXISTS') {
      const theirs = readMasterKeyFile(path);
      if (theirs) return theirs;
    }
    throw err;
  }
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

// ─── Key check value (FA-07) ─────────────────────────────────────────────────
//
// A key file that exists is not proof that it is THE key: a copy of the
// database restored next to another install's key, or a key minted on a new
// machine before the data was copied over, passes every "is the file there"
// test and then fails credential by credential, at first use. The database
// therefore keeps a check value, a known text encrypted with the key it was
// encrypted with; a start opens it with the key file before anything else
// reads a secret (packages/db/src/queries/master-key-guard.ts).

const MASTER_KEY_CHECK_TEXT = 'nodal-agents master key check v1';

/** The check value for `key`: a known text, encrypted with it. */
export function masterKeyCheckValue(key: Buffer): string {
  return encrypt(MASTER_KEY_CHECK_TEXT, key);
}

/** True when `check` was made with `key`. Any failure to open it is a no. */
export function masterKeyMatchesCheck(check: string, key: Buffer): boolean {
  try {
    return decrypt(check, key) === MASTER_KEY_CHECK_TEXT;
  } catch {
    return false;
  }
}

/** True when `blob` opens with `key` (a stored secret, used to recognise the key). */
export function decryptsWith(blob: string, key: Buffer): boolean {
  try {
    decrypt(blob, key);
    return true;
  } catch {
    return false;
  }
}
