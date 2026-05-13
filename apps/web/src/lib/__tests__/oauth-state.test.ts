// oauth-state.test.ts — unit tests for PKCE + signed cookie helpers.
// Uses _setMasterKeyForTests to avoid touching ~/.nodalai/secrets.key.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import {
  generatePkce,
  generateState,
  signStatePayload,
  verifyStateCookie,
  STATE_COOKIE_NAME,
  STATE_TTL_MS,
  type StatePayload,
} from '../oauth-state.ts';

beforeAll(() => {
  _setMasterKeyForTests(randomBytes(32));
});

afterEach(() => {
  // Reset so each test can inject a fresh key if needed.
  _resetMasterKeyCacheForTests();
  _setMasterKeyForTests(randomBytes(32));
});

// ─── generatePkce ─────────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('returns codeVerifier within spec-compliant length [43, 128]', () => {
    const { codeVerifier } = generatePkce();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('codeVerifier contains only base64url characters', () => {
    const { codeVerifier } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('codeChallenge is SHA-256 of codeVerifier in base64url (no padding)', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(codeChallenge).toBe(expected);
  });

  it('generates different values on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

// ─── generateState ────────────────────────────────────────────────────────────

describe('generateState', () => {
  it('returns a 32-char hex string (16 random bytes)', () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates different values on each call', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

// ─── signStatePayload + verifyStateCookie ─────────────────────────────────────

function makePayload(overrides: Partial<StatePayload> = {}): StatePayload {
  return {
    v: 1,
    slug: 'google-drive',
    entityId: 'aaaaaaaa-0000-0000-0000-000000000001',
    state: generateState(),
    codeVerifier: generatePkce().codeVerifier,
    clientId: 'test-client-id',
    clientSecretEnc: 'enc:v1:dummyIv:dummyTag:dummyCt',
    credentialType: 'google-oauth',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('signStatePayload + verifyStateCookie roundtrip', () => {
  it('returns the original payload on valid cookie', () => {
    const key = randomBytes(32);
    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key);

    const payload = makePayload();
    const cookie = signStatePayload(payload);
    const result = verifyStateCookie(cookie);

    expect(result).not.toBeNull();
    expect(result?.slug).toBe(payload.slug);
    expect(result?.entityId).toBe(payload.entityId);
    expect(result?.state).toBe(payload.state);
    expect(result?.clientId).toBe(payload.clientId);
  });

  it('cookie has format {b64url}.{b64url} (single dot separator)', () => {
    const payload = makePayload();
    const cookie = signStatePayload(payload);
    // Should have exactly ONE dot separating payload from HMAC.
    // The payload part is base64url(JSON) — JSON can't contain '.' so splitting
    // on the LAST dot is reliable (which is what verifyStateCookie does).
    const parts = cookie.split('.');
    expect(parts.length).toBe(2);
  });
});

describe('verifyStateCookie — tamper rejection', () => {
  it('returns null when cookie has no dot', () => {
    expect(verifyStateCookie('nodot')).toBeNull();
  });

  it('returns null when HMAC is wrong (tampered sig)', () => {
    const payload = makePayload();
    const cookie = signStatePayload(payload);
    const tampered = cookie.slice(0, -4) + 'XXXX';
    expect(verifyStateCookie(tampered)).toBeNull();
  });

  it('returns null when payload bytes are changed (tampered payload)', () => {
    const payload = makePayload();
    const cookie = signStatePayload(payload);
    const dotIdx = cookie.lastIndexOf('.');
    const sig = cookie.slice(dotIdx);
    // Flip one char in the encoded payload
    const encoded = cookie.slice(0, dotIdx);
    const tampered = encoded.slice(0, -1) + (encoded.slice(-1) === 'A' ? 'B' : 'A') + sig;
    expect(verifyStateCookie(tampered)).toBeNull();
  });

  it('returns null when signed with a different key', () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);

    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key1);
    const cookie = signStatePayload(makePayload());

    // Switch to a different key for verification
    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key2);
    expect(verifyStateCookie(cookie)).toBeNull();
  });
});

describe('verifyStateCookie — TTL expiry', () => {
  it('returns null when createdAt is older than STATE_TTL_MS', () => {
    const expired = makePayload({
      createdAt: Date.now() - STATE_TTL_MS - 1000, // 1s past the TTL
    });
    const cookie = signStatePayload(expired);
    expect(verifyStateCookie(cookie)).toBeNull();
  });

  it('returns payload when createdAt is just within TTL', () => {
    const fresh = makePayload({
      createdAt: Date.now() - STATE_TTL_MS + 5000, // 5s before expiry
    });
    const cookie = signStatePayload(fresh);
    expect(verifyStateCookie(cookie)).not.toBeNull();
  });
});

describe('STATE_COOKIE_NAME constant', () => {
  it('is a non-empty string', () => {
    expect(typeof STATE_COOKIE_NAME).toBe('string');
    expect(STATE_COOKIE_NAME.length).toBeGreaterThan(0);
  });
});

describe('StatePayload — credentialType + returnTo fields', () => {
  it('credentialType is preserved in the roundtrip', () => {
    const key = randomBytes(32);
    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key);

    const payload = makePayload({ credentialType: 'notion-oauth' });
    const cookie = signStatePayload(payload);
    const result = verifyStateCookie(cookie);

    expect(result?.credentialType).toBe('notion-oauth');
  });

  it('returnTo is preserved in the roundtrip when set', () => {
    const key = randomBytes(32);
    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key);

    const payload = makePayload({ returnTo: '/connectors?connectorSlug=google-drive' });
    const cookie = signStatePayload(payload);
    const result = verifyStateCookie(cookie);

    expect(result?.returnTo).toBe('/connectors?connectorSlug=google-drive');
  });

  it('returnTo is absent (undefined) when not set', () => {
    const key = randomBytes(32);
    _resetMasterKeyCacheForTests();
    _setMasterKeyForTests(key);

    const payload = makePayload();
    const cookie = signStatePayload(payload);
    const result = verifyStateCookie(cookie);

    expect(result?.returnTo).toBeUndefined();
  });
});
