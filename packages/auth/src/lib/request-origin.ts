// Decide whether an inbound HTTP request may act on this install, from its
// `Origin` and `Host` headers alone.
//
// NETWORK-001 (audit 2026-08-07). Binding to 127.0.0.1 keeps the runner off the
// network, but it does NOT keep the user's own browser out: any page the user
// visits can POST to http://127.0.0.1:3001/api/agent. Measured on a real install
// in the DEFAULT configuration (bind=loopback → AUTH_MODE=local-trust):
//
//   POST /api/agent, no Authorization                       → 202, job created
//   POST /api/agent, Origin: https://attacker.test          → 202, job created
//   POST /api/agent, Host: evil.test                        → 202, job created
//   POST /api/agent, Content-Type: text/plain (no preflight)→ 202, job created
//
// and the runner log showed `[exec …] enter` — the agent actually started. So a
// single visited page could dispatch arbitrary tasks to an agent holding file
// and connector tools.
//
// Two distinct checks, because they stop two distinct attacks:
//
//   Origin — stops ordinary CSRF. A browser always attaches `Origin` to a
//     cross-origin POST and cannot forge it. A request with NO `Origin` is not a
//     browser (curl, a script, the dashboard's own server-side fetch) and is
//     allowed: withholding the header is not something a hostile page can do.
//
//   Host — stops DNS rebinding, where the attacker points their own hostname at
//     127.0.0.1 so the browser sends `Origin: http://evil.test` AND
//     `Host: evil.test`. The two AGREE, so an Origin-vs-Host comparison (what
//     Next's server actions do — verified: it returns 200 for that pair) passes.
//     Pinning `Host` to names that can only mean this machine closes it.

import { isPrivateOrigin } from './private-origin.ts';

/** Hostnames that can only ever mean "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Strip an optional `:port` and IPv6 brackets from a Host header value. */
function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed.slice(1) : trimmed.slice(1, close);
  }
  // A bare (unbracketed) IPv6 literal is malformed per RFC 7230 but shows up in
  // hand-written clients — it has several colons and no port, so splitting on
  // the last one would mangle it. Only strip a port when exactly one colon is
  // present AND what follows is numeric.
  const colon = trimmed.indexOf(':');
  if (
    colon !== -1 &&
    colon === trimmed.lastIndexOf(':') &&
    /^\d+$/.test(trimmed.slice(colon + 1))
  ) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

/** The hostname an APP_URL points at, or null when it is unparseable. */
function hostnameOfUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export interface RequestOriginCheck {
  /** Raw `Origin` header, or null/undefined when absent. */
  origin?: string | null;
  /** Raw `Host` header, or null/undefined when absent. */
  host?: string | null;
  /** The install's own base URL (runner env APP_URL). */
  appUrl?: string | undefined;
}

/**
 * True when the request's `Host` names this machine.
 *
 * Accepted: loopback names and addresses, RFC1918 / link-local-free private
 * addresses (LAN mode — the user reaches the dashboard by IP from a phone), and
 * whatever APP_URL points at (an operator who fronts the install with a name).
 * Everything else is rejected, which is what defeats rebinding.
 *
 * A missing `Host` is rejected: HTTP/1.1 requires it, so its absence is either a
 * malformed request or an attempt to dodge this check.
 */
export function isAllowedHost(host: string | null | undefined, appUrl?: string): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  // isPrivateOrigin works on a URL, so give it one; it also covers loopback,
  // which the set above already handled.
  if (isPrivateOrigin(`http://${name.includes(':') ? `[${name}]` : name}`)) return true;
  const configured = hostnameOfUrl(appUrl);
  return configured !== null && configured === name;
}

/**
 * True when the request's `Origin` is one this install accepts.
 *
 * An ABSENT `Origin` is allowed — see the header note above: a hostile page
 * cannot suppress it, so its absence means the caller is not a browser.
 */
export function isAllowedOrigin(origin: string | null | undefined, appUrl?: string): boolean {
  if (!origin) return true;
  // Some browsers send the literal "null" for opaque origins (sandboxed iframe,
  // data: document, file://). Those are exactly the contexts an attacker uses to
  // hide where a request came from — refuse.
  if (origin === 'null') return false;
  if (isPrivateOrigin(origin)) return true;
  const configured = hostnameOfUrl(appUrl);
  const candidate = hostnameOfUrl(origin);
  return configured !== null && candidate !== null && configured === candidate;
}

export type OriginRejection = 'origin_not_allowed' | 'host_not_allowed';

/**
 * Full decision for one request. Returns null when the request may proceed, or
 * the reason it was refused.
 *
 * Deliberately NOT applied to `/webhooks/:slug/:secret`: that route exists to be
 * called by third-party services, which legitimately arrive with an arbitrary
 * `Host` (a tunnel hostname, a reverse proxy). Its authentication is the
 * slug+secret pair in the path, checked against the webhook_triggers row.
 */
export function checkRequestOrigin(input: RequestOriginCheck): OriginRejection | null {
  if (!isAllowedOrigin(input.origin, input.appUrl)) return 'origin_not_allowed';
  if (!isAllowedHost(input.host, input.appUrl)) return 'host_not_allowed';
  return null;
}
