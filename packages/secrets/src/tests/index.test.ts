import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  encrypt,
  decrypt,
  isEncrypted,
  last4,
  loadOrCreateMasterKey,
  masterKeyPath,
  _resetMasterKeyCacheForTests,
} from '../index.ts';

describe('@nodalai/secrets', () => {
  // Use a fresh temp dir + key per test so we never touch ~/.nodalai/secrets.key.
  let tmp: string;
  let keyPath: string;

  beforeEach(() => {
    _resetMasterKeyCacheForTests();
    tmp = mkdtempSync(join(tmpdir(), 'nodalai-secrets-test-'));
    keyPath = join(tmp, 'secrets.key');
  });

  afterEach(() => {
    _resetMasterKeyCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('loadOrCreateMasterKey', () => {
    it('creates a 32-byte key file when absent', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(key.length).toBe(32);
      expect(existsSync(keyPath)).toBe(true);
      const onDisk = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'base64');
      expect(onDisk.equals(key)).toBe(true);
    });

    it('reuses an existing key file', () => {
      const key1 = loadOrCreateMasterKey(keyPath);
      _resetMasterKeyCacheForTests();
      const key2 = loadOrCreateMasterKey(keyPath);
      expect(key1.equals(key2)).toBe(true);
    });

    it('caches the key across calls without disk I/O', () => {
      const key1 = loadOrCreateMasterKey(keyPath);
      // Now corrupt the file — cached key should still be returned.
      writeFileSync(keyPath, 'garbage', 'utf-8');
      const key2 = loadOrCreateMasterKey(keyPath);
      expect(key1.equals(key2)).toBe(true);
    });

    it('throws if the file exists but is malformed (wrong length)', () => {
      writeFileSync(keyPath, Buffer.from('short').toString('base64'), 'utf-8');
      expect(() => loadOrCreateMasterKey(keyPath)).toThrow(/malformed/);
    });

    it('persists the key with mode 0600 on Unix', () => {
      loadOrCreateMasterKey(keyPath);
      const stat = statSync(keyPath);
      // On Unix, lower 9 bits encode rwx perms — expect 0600 (-rw-------).
      // On Windows, NTFS doesn't honor chmod and stat.mode is synthetic; skip the check.
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('returns a default path under the user homedir when no path is given', () => {
      const p = masterKeyPath();
      expect(p).toMatch(/[\\/]\.nodalai[\\/]secrets\.key$/);
    });
  });

  describe('isEncrypted', () => {
    it('returns true on encrypt() output', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(isEncrypted(encrypt('hello', key))).toBe(true);
    });

    it('returns false on plaintext', () => {
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted('sk-test12345')).toBe(false);
      expect(isEncrypted('enc:v0:foo')).toBe(false);
      expect(isEncrypted('enc:v2:foo')).toBe(false);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    it.each([
      ['empty', ''],
      ['1 char', 'x'],
      ['16 chars', 'sk-ant-test12345'],
      ['typical key', 'sk-ant-api03-1234567890abcdefghijklmnop'],
      ['1k chars', 'a'.repeat(1000)],
      ['utf-8 multibyte', '🔐 secret avec accents éàù 你好'],
    ])('round-trips %s', (_label, plaintext) => {
      const key = loadOrCreateMasterKey(keyPath);
      const ct = encrypt(plaintext, key);
      const pt = decrypt(ct, key);
      expect(pt).toBe(plaintext);
    });

    it('returns "" unchanged for empty plaintext (no encryption)', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(encrypt('', key)).toBe('');
      expect(decrypt('', key)).toBe('');
    });

    it('produces a fresh IV on every call (no determinism)', () => {
      const key = loadOrCreateMasterKey(keyPath);
      const ciphertexts = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ciphertexts.add(encrypt('same-plaintext', key));
      }
      expect(ciphertexts.size).toBe(1000);
    });

    it('output starts with the version-prefixed marker', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(encrypt('hello', key).startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('decrypt — failure modes', () => {
    it('throws on plaintext-looking input', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(() => decrypt('sk-test12345', key)).toThrow(/not encrypted/);
    });

    it('throws on malformed ciphertext (missing parts)', () => {
      const key = loadOrCreateMasterKey(keyPath);
      expect(() => decrypt('enc:v1:onlyone', key)).toThrow(/malformed/);
      expect(() => decrypt('enc:v1::tag:ct', key)).toThrow(/malformed/);
    });

    it('throws when the auth tag is tampered with', () => {
      const key = loadOrCreateMasterKey(keyPath);
      const ct = encrypt('confidential', key);
      // Flip the last char of the ciphertext segment (likely changes the tag's
      // verification — GCM detects tampering anywhere in IV/AAD/CT).
      const tampered = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('throws when the wrong master key is used', () => {
      const keyA = loadOrCreateMasterKey(keyPath);
      const ct = encrypt('mysecret', keyA);
      const keyB = randomBytes(32);
      expect(() => decrypt(ct, keyB)).toThrow();
    });
  });

  describe('last4', () => {
    it('returns the last 4 chars of a long string', () => {
      expect(last4('sk-ant-1234567890abcd')).toBe('abcd');
    });

    it('returns the whole string when ≤ 4 chars', () => {
      expect(last4('')).toBe('');
      expect(last4('ab')).toBe('ab');
      expect(last4('abcd')).toBe('abcd');
    });
  });
});
