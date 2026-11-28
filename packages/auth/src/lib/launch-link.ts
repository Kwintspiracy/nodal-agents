// The dashboard's way in, in the mode with no password: a launch link, then a
// cookie. Both are derived from the install's secret (the worker secret of
// config.json), which only the owner's operating-system account can read.
//
//   launch link   `<dashboard>/?nodal_launch=<token>`, minted by a program
//                 that read the secret (`nodal-agents up`, `nodal-agents
//                 open`). The token names an expiry and a random nonce, and is
//                 signed with the secret. The dashboard accepts it ONCE (its
//                 ledger remembers the nonce until the expiry), sets the
//                 cookie, and redirects to the same address without it.
//   cookie        `nodal_dash_<id of this install>`, `HttpOnly`,
//                 `SameSite=Strict`: an issue date signed with the secret. It
//                 holds as long as a browser keeps a cookie at most, and stops
//                 holding the day the secret changes.
//
// The cookie proves who the BROWSER is. It never proves who sent a request on
// behalf of a page: the browser attaches it by itself, so the Origin rule
// (request-origin.ts) never counts it.
//
// Pure functions and node:crypto only: the CLI, the dashboard's proxy and the
// repository's scripts (run by Node itself, without a build) import this file.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The query parameter a launch link carries. */
export const LAUNCH_PARAM = 'nodal_launch';

/** How long a launch link may wait before it is used. */
export const LAUNCH_TTL_MS = 10 * 60_000;

/**
 * How long the dashboard cookie holds: 400 days, the longest a browser keeps a
 * cookie (RFC 6265bis caps `Max-Age` there). A person is not asked again.
 */
export const DASHBOARD_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Why a launch token or a cookie does not hold. */
export type LaunchRefusal = 'launch_malformed' | 'launch_invalid' | 'launch_expired';

function requireSecret(secret: string): void {
  if (secret.length === 0) {
    // Invariant #4: no link and no cookie can be derived from nothing.
    throw new Error('install_secret_missing: the worker secret is empty');
  }
}

/** HMAC-SHA256 of `parts`, under a purpose of its own, base64url. */
function mac(secret: string, purpose: string, parts: readonly string[]): string {
  return createHmac('sha256', secret)
    .update(`nodal:${purpose}:v1|${parts.join('|')}`)
    .digest('base64url');
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A launch token: `<expiry, base 36>.<nonce>.<signature>`. */
export function mintLaunchToken(
  secret: string,
  now: number = Date.now(),
  nonce: string = randomBytes(18).toString('base64url'),
): string {
  requireSecret(secret);
  const expires = (now + LAUNCH_TTL_MS).toString(36);
  return `${expires}.${nonce}.${mac(secret, 'launch', [expires, nonce])}`;
}

export type LaunchVerdict =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: LaunchRefusal };

export function verifyLaunchToken(secret: string, token: string, now: number): LaunchVerdict {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { ok: false, reason: 'launch_malformed' };
  }
  const [expires, nonce, signature] = parts as [string, string, string];
  const expiresAt = Number.parseInt(expires, 36);
  if (!Number.isSafeInteger(expiresAt)) return { ok: false, reason: 'launch_malformed' };
  if (secret.length === 0 || !sameMac(signature, mac(secret, 'launch', [expires, nonce]))) {
    return { ok: false, reason: 'launch_invalid' };
  }
  if (now > expiresAt) return { ok: false, reason: 'launch_expired' };
  return { ok: true, nonce, expiresAt };
}

/**
 * The dashboard link that lets one browser in: `baseUrl` (any path of the
 * dashboard) with a fresh launch token.
 */
export function launchUrl(baseUrl: string, secret: string, now: number = Date.now()): string {
  const url = new URL(baseUrl);
  url.searchParams.set(LAUNCH_PARAM, mintLaunchToken(secret, now));
  return url.toString();
}

/**
 * The cookie's name: one per install, so that two installs reached on the same
 * host name (a dev stack and an installed one, on two ports) each keep theirs.
 * A cookie is not bound to a port; its name is.
 */
export function dashboardCookieName(secret: string): string {
  requireSecret(secret);
  const id = createHmac('sha256', secret).update('nodal:cookie-name:v1').digest('hex').slice(0, 12);
  return `nodal_dash_${id}`;
}

/** The cookie's value: `<issue date, base 36>.<signature>`. */
export function mintDashboardCookie(secret: string, now: number = Date.now()): string {
  requireSecret(secret);
  const issued = now.toString(36);
  return `${issued}.${mac(secret, 'dashboard', [issued])}`;
}

/** Null when the value holds, else why not. */
export function verifyDashboardCookie(
  secret: string,
  value: string,
  now: number,
): LaunchRefusal | null {
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return 'launch_malformed';
  }
  const [issued, signature] = parts as [string, string];
  const issuedAt = Number.parseInt(issued, 36);
  if (!Number.isSafeInteger(issuedAt)) return 'launch_malformed';
  if (secret.length === 0 || !sameMac(signature, mac(secret, 'dashboard', [issued]))) {
    return 'launch_invalid';
  }
  if (now - issuedAt > DASHBOARD_COOKIE_MAX_AGE_S * 1000) return 'launch_expired';
  return null;
}

/**
 * The nonces of the launch links already used, each kept until its link would
 * have expired anyway. A link is accepted once per ledger: the dashboard keeps
 * one for its whole life. A restarted dashboard starts an empty one, which is
 * why a link expires within LAUNCH_TTL_MS.
 */
export class LaunchLedger {
  readonly #used = new Map<string, number>();

  /** True the first time `nonce` is seen; false after. */
  consume(nonce: string, expiresAt: number, now: number): boolean {
    for (const [n, exp] of this.#used) if (exp < now) this.#used.delete(n);
    if (this.#used.has(nonce)) return false;
    this.#used.set(nonce, expiresAt);
    return true;
  }
}
