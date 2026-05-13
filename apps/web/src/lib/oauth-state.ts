// oauth-state.ts — PKCE + signed cookie helpers for the OAuth roundtrip.
// Cookie format: base64url(JSON.stringify(payload)).base64url(hmac_sha256)
// HMAC key: the master key loaded from packages/secrets (any-length input is valid for HMAC-SHA256).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadOrCreateMasterKey } from '@nodal-agents/secrets';

export const STATE_COOKIE_NAME = 'nodalai_oauth_state';
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type StatePayload = {
  v: 1;
  slug: string;
  entityId: string;
  /** CSRF token */
  state: string;
  /** PKCE code_verifier (base64url, 43-128 chars). Empty string when pkce === 'none'. */
  codeVerifier: string;
  clientId: string;
  /** Ciphertext of clientSecret from packages/secrets encrypt() */
  clientSecretEnc: string;
  /** Optional display name for the new credential */
  name?: string;
  /**
   * The CredentialType resolved from the provider registry.
   * Stored so the callback knows which credentials table type to insert.
   */
  credentialType: string;
  /**
   * Optional URL to redirect to after the OAuth flow completes.
   * The callback appends ?credentialId={id} (or merges into existing query).
   * When absent, defaults to /credentials?created={id}.
   */
  returnTo?: string;
  createdAt: number;
};

// ─── PKCE ─────────────────────────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier (43 random base64url chars, spec-compliant)
 * and its SHA-256 code_challenge.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  // 32 random bytes → 43 base64url chars (floor(32 * 4/3) = 42, but base64 rounds up to 44 then we strip padding)
  // Use 48 bytes to get a 64-char base64url, then truncate to 64 (all valid per spec 43-128).
  const raw = randomBytes(48);
  const codeVerifier = raw
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

// ─── CSRF state ────────────────────────────────────────────────────────────────

/** Generate a 16-byte hex CSRF token. */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ─── Signed cookie ────────────────────────────────────────────────────────────

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64Url(input: string): string {
  // Re-pad to a multiple of 4
  const padded = input + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function hmacSha256(data: string, key: Buffer): string {
  return createHmac('sha256', key)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Sign a StatePayload and return the cookie value.
 * Format: {b64url(json)}.{b64url(hmac)}
 */
export function signStatePayload(payload: StatePayload): string {
  const masterKey = loadOrCreateMasterKey();
  const encoded = toBase64Url(JSON.stringify(payload));
  const sig = hmacSha256(encoded, masterKey);
  return `${encoded}.${sig}`;
}

/**
 * Verify a cookie value against the HMAC and TTL.
 * Returns the parsed StatePayload, or null if invalid/expired.
 */
export function verifyStateCookie(cookieValue: string): StatePayload | null {
  const dotIdx = cookieValue.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const encoded = cookieValue.slice(0, dotIdx);
  const providedSig = cookieValue.slice(dotIdx + 1);

  const masterKey = loadOrCreateMasterKey();
  const expectedSig = hmacSha256(encoded, masterKey);

  // Constant-time comparison to prevent timing attacks
  if (encoded.length === 0 || providedSig.length !== expectedSig.length) return null;
  try {
    const sigA = Buffer.from(providedSig, 'ascii');
    const sigB = Buffer.from(expectedSig, 'ascii');
    if (!timingSafeEqual(sigA, sigB)) return null;
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload as Record<string, unknown>)['v'] !== 1
  ) {
    return null;
  }

  const p = payload as StatePayload;

  // TTL check
  if (Date.now() - p.createdAt > STATE_TTL_MS) return null;

  return p;
}
