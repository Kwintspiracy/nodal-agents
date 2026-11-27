// Decide whether an inbound HTTP request may be served, from facts about the
// request alone. ONE decision, used at every door of both servers: the
// runner's `/api/*` middleware (apps/runner/src/lib/admission.ts) and the
// dashboard's proxy (apps/web/src/proxy.ts), which runs on every path.
//
// Four rules, checked in this order:
//
//   Host   — the request names this machine (loopback, a private address, or
//     the host APP_URL points at). This is what defeats DNS rebinding, where a
//     hostile name is pointed at 127.0.0.1 and the browser's `Origin` and
//     `Host` agree, so no Origin-vs-Host comparison can catch it.
//
//   Origin — a browser attaches `Origin` to every request it sends on behalf of
//     a page (every non-GET request, and every CORS-mode GET), and a page can
//     neither forge nor remove it. A request that carries one is served only
//     when it proves who sends it by a credential a page cannot have by itself
//     (the install's worker secret, its API token, a paired device's key: an
//     explicit header, never a cookie the browser attaches on its own), or
//     when it comes from a page this very server serves (its Origin is the
//     request's own Host: the dashboard's own pages). Where a page lives never counts: a private
//     address, another port of this machine, the dashboard's origin calling the
//     runner are all refused without a credential. The runner serves no page,
//     so every request with an `Origin` and no credential is refused there.
//     A request with NO `Origin` is not sent on behalf of a page, and this rule
//     does not apply to it (the next one does).
//
//   Caller — every request proves it holds what only the owner's
//     operating-system account can read, in every auth mode: the install's
//     worker secret in an explicit header, the API token in bearer-token mode,
//     a paired device's key on a route that takes one, or, for the dashboard's
//     browser in the mode with no password, the launch cookie that a launch
//     link derived from that secret (launch-link.ts). "No password" never
//     means "no proof". The only routes out of this rule are those whose
//     handler checks a proof of its own; each server names them.
//
//   Body   — a request that carries a body declares a media type the route
//     takes (JSON unless the route declares others). The types a page can send
//     without a preflight (`text/plain`, a form) are thereby refused on every
//     JSON route, whoever sends them.
//
// The decision is pure: each server gathers the facts (and verifies the
// credential itself, before calling), then acts on the verdict.

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
 * True when `origin` is the origin of a page served under `host`: same
 * hostname and same port, the port defaulting by the Origin's scheme on both
 * sides (the Host is read with the Origin's scheme, so `localhost` and
 * `localhost:80` compare equal for an `http:` page).
 */
function isSameOrigin(origin: string, host: string | null | undefined): boolean {
  if (!host) return false;
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return false;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  try {
    return new URL(`${page.protocol}//${host.trim()}`).host === page.host;
  } catch {
    return false;
  }
}

/** The media type of a Content-Type value: what comes before `;`, lower-cased. */
export function mediaTypeOf(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return type === '' ? null : type;
}

/**
 * Whether a request carries a body, from its framing headers (RFC 9112 §6.3):
 * a `Transfer-Encoding`, or a `Content-Length` other than 0. A request with
 * neither has no body, whatever its method.
 */
export function hasRequestBody(headers: { get(name: string): string | null }): boolean {
  if (headers.get('transfer-encoding') !== null) return true;
  const length = headers.get('content-length');
  if (length === null) return false;
  // An unparseable length is not "no body": never guess in the lenient direction.
  return length.trim() !== '0';
}

/**
 * A credential the request carries, verified by the server: the first three in
 * an explicit header, the last as the dashboard's cookie.
 */
export type RequestProof = 'worker_secret' | 'api_token' | 'device_key' | 'launch_cookie';

/**
 * The proofs that also say who sent a request on behalf of a page. A cookie is
 * not one: the browser attaches it by itself, to a foreign page's request too.
 */
const HEADER_PROOFS: ReadonlySet<RequestProof> = new Set([
  'worker_secret',
  'api_token',
  'device_key',
]);

/** The media type a route takes in a body unless it declares others. */
export const JSON_BODY: readonly string[] = ['application/json'];

export interface RequestFacts {
  /** Raw `Origin` header, or null/undefined when absent. */
  origin?: string | null | undefined;
  /** Raw `Host` header (or the HTTP/2 authority), or null/undefined when absent. */
  host?: string | null | undefined;
  /** The install's own base URL (its host is accepted as a Host). */
  appUrl?: string | undefined;
  /**
   * The credential this request carries, ALREADY VERIFIED by the server
   * (constant-time secret comparison, device key lookup). Null: none.
   */
  proof: RequestProof | null;
  /**
   * Whether the request presented a credential at all (an `Authorization`
   * header, a launch cookie), whether or not it held: what tells a wrong proof
   * from a missing one.
   */
  proofPresented: boolean;
  /**
   * Whether the route asks its caller to prove who it is here. True on every
   * route, in every auth mode, except a route whose own handler checks a proof
   * of its own (its server names them), and the dashboard in the modes with a
   * sign-in, whose pages and actions check the session themselves.
   */
  proofRequired: boolean;
  /**
   * Whether this server serves pages of its own, under the Host it is reached
   * at. The dashboard does; the runner does not, so no Origin is ever its own.
   */
  servesPages: boolean;
  /** Raw `Content-Type` header, or null/undefined when absent. */
  contentType?: string | null | undefined;
  /** Whether the request carries a body (`hasRequestBody`). */
  hasBody: boolean;
  /** The media types the route takes in a body (`JSON_BODY` unless it declares others). */
  bodyTypes: readonly string[];
}

/**
 * A refusal: a stable HTTP status and a machine-readable reason.
 *   403 host_not_allowed        — the Host does not name this machine
 *   403 origin_not_allowed      — sent on behalf of a page, with no credential
 *   401 proof_required          — the caller presented no proof
 *   401 proof_invalid           — the caller presented one that does not hold
 *   415 unsupported_media_type  — a body of a type the route does not take
 */
export type AdmissionRefusal =
  | { status: 403; reason: 'host_not_allowed' }
  | { status: 403; reason: 'origin_not_allowed' }
  | { status: 401; reason: 'proof_required' }
  | { status: 401; reason: 'proof_invalid' }
  | { status: 415; reason: 'unsupported_media_type' };

/** The decision for one request: null when it may be served, else why it is refused. */
export function admitRequest(facts: RequestFacts): AdmissionRefusal | null {
  if (!isAllowedHost(facts.host, facts.appUrl)) {
    return { status: 403, reason: 'host_not_allowed' };
  }
  if (facts.origin) {
    // The literal "null" (sandboxed iframe, data: document, file://) is an
    // Origin like any other: sent on behalf of a page, and never this
    // server's own.
    const ownPage = facts.servesPages && isSameOrigin(facts.origin, facts.host);
    const headerProof = facts.proof !== null && HEADER_PROOFS.has(facts.proof);
    if (!headerProof && !ownPage) {
      return { status: 403, reason: 'origin_not_allowed' };
    }
  }
  if (facts.proofRequired && facts.proof === null) {
    return facts.proofPresented
      ? { status: 401, reason: 'proof_invalid' }
      : { status: 401, reason: 'proof_required' };
  }
  if (facts.hasBody) {
    const type = mediaTypeOf(facts.contentType);
    if (type === null || !facts.bodyTypes.includes(type)) {
      return { status: 415, reason: 'unsupported_media_type' };
    }
  }
  return null;
}

/** A route that takes a body of another type than JSON, and which types. */
export interface BodyRoute {
  method: string;
  /** Path pattern: `:name` is one non-empty segment. */
  path: string;
  types: readonly string[];
}

function matchesPattern(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return (
    a.length === b.length &&
    a.every((seg, i) => (seg.startsWith(':') ? (b[i] ?? '') !== '' : seg === b[i]))
  );
}

/**
 * The media types the route at `method path` takes in a body: what `declared`
 * names for it, else JSON. A route that takes something else says so in its
 * server's table; there is no route that takes "anything".
 */
export function bodyTypesFor(
  method: string,
  path: string,
  declared: readonly BodyRoute[],
): readonly string[] {
  const m = method.toUpperCase();
  return declared.find((r) => r.method === m && matchesPattern(r.path, path))?.types ?? JSON_BODY;
}
