// connection-state.ts — what Nodal knows about a connection, in one vocabulary
// for every kind of source: an OAuth credential, a connector, an MCP server, a
// messaging channel.
//
// A connection has a state the product keeps. It is written by the one place
// that learns it (the token refresh, the connector call, the MCP connect, the
// channel's link) and read by three: the dashboard, the agent's context and the
// tool's error. The three read the same row, so they say the same thing.
//
// The states form a closed set, the same for every source:
//   working       the last attempt succeeded, or nothing has refused it since
//                 it was set up (`not_checked`: nothing observed yet);
//   needs_reauth  the provider refused the grant or the key, or a right the
//                 connection needs is missing: only the person can repair it,
//                 by authorising again;
//   unreachable   the provider could not be reached (network, time-out, 5xx):
//                 the next attempt is made after `retryAfter`;
//   broken        Nodal cannot use what it holds (a secret it cannot decrypt,
//                 a command that does not start).
//
// Classification is by protocol, never by provider: the OAuth 2.0 error codes
// of a token endpoint (RFC 6749 §5.2), the HTTP status of a call, the operating
// system's network error codes. No line here names a provider.

export const CONNECTION_STATES = ['working', 'needs_reauth', 'unreachable', 'broken'] as const;
export type ConnectionStateKind = (typeof CONNECTION_STATES)[number];

export const CONNECTION_SOURCE_KINDS = [
  'credential',
  'connector',
  'mcp_server',
  'channel',
] as const;
export type ConnectionSourceKind = (typeof CONNECTION_SOURCE_KINDS)[number];

/** Why a connection is in its state. Each cause belongs to exactly one state. */
export const CONNECTION_CAUSES = {
  working: ['not_checked', 'authorised', 'succeeded'],
  needs_reauth: [
    'grant_refused',
    'rights_missing',
    'credential_removed',
    'key_missing',
    'rotation_lost',
    'no_refresh',
  ],
  unreachable: ['network', 'timeout', 'provider_unavailable'],
  broken: ['undecryptable', 'command_not_found', 'config_incomplete'],
} as const satisfies Record<ConnectionStateKind, readonly string[]>;

export type ConnectionCause = (typeof CONNECTION_CAUSES)[ConnectionStateKind][number];

export type ConnectionState = {
  state: ConnectionStateKind;
  cause: ConnectionCause;
  /**
   * The provider's own words, as data: an OAuth error code and description, an
   * HTTP status and message, a spawn error. Never a sentence of Nodal's.
   */
  detail: string | null;
  /** When it was learnt. Null: nothing has been observed since it was set up. */
  observedAt: Date | null;
  /** `unreachable` only: no attempt is made before this time. */
  retryAfter: Date | null;
};

/** Which row a state belongs to. A channel is keyed by its agent and its name. */
export type ConnectionRef = { kind: ConnectionSourceKind; id: string };

export function channelConnectionId(agentId: string, channel: string): string {
  return `${agentId}:${channel}`;
}

export function connectionKey(ref: ConnectionRef): string {
  return `${ref.kind}/${ref.id}`;
}

/** A connection about which nothing has been learnt since it was set up. */
export const NOT_CHECKED: ConnectionState = Object.freeze({
  state: 'working',
  cause: 'not_checked',
  detail: null,
  observedAt: null,
  retryAfter: null,
}) as ConnectionState;

/** How long an unreachable provider is left alone before the next attempt. */
export const UNREACHABLE_RETRY_MS = 60_000;

export function connectionState(
  state: ConnectionStateKind,
  cause: ConnectionCause,
  detail: string | null,
  observedAt: Date = new Date(),
  retryAfter: Date | null = null,
): ConnectionState {
  if (!(CONNECTION_CAUSES[state] as readonly string[]).includes(cause)) {
    throw new Error(`connectionState: cause '${cause}' does not belong to state '${state}'`);
  }
  return { state, cause, detail, observedAt, retryAfter };
}

/** Whether a stored pair (state, cause) is one of the closed set. */
export function isConnectionState(state: string, cause: string): boolean {
  return (
    (CONNECTION_STATES as readonly string[]).includes(state) &&
    (CONNECTION_CAUSES[state as ConnectionStateKind] as readonly string[]).includes(cause)
  );
}

/**
 * Whether a source is offered to a job. `working` and `unreachable` are: an
 * unreachable provider may answer the next attempt, and the tool's error says
 * when. `needs_reauth` and `broken` are not: no call can succeed until the
 * person sets the connection up again, so the agent is told instead.
 */
export function isOffered(connection: ConnectionState): boolean {
  return connection.state === 'working' || connection.state === 'unreachable';
}

/**
 * Whether a network attempt is due. A refused grant is not retried at all:
 * the next attempt follows the person authorising again (the OAuth return,
 * a new key, "Refresh now"), which writes the state anew. An unreachable
 * provider is retried once `retryAfter` has passed.
 */
export function attemptDue(connection: ConnectionState, now: Date = new Date()): boolean {
  if (connection.state === 'needs_reauth' || connection.state === 'broken') return false;
  if (connection.state === 'unreachable') {
    return connection.retryAfter === null || connection.retryAfter.getTime() <= now.getTime();
  }
  return true;
}

const SEVERITY: Record<ConnectionStateKind, number> = {
  working: 0,
  unreachable: 1,
  needs_reauth: 2,
  broken: 3,
};

/**
 * The state of a connection made of several rows (a connector and the
 * credential it uses): the most severe, and among equals the latest learnt.
 */
export function worstConnection(...states: ConnectionState[]): ConnectionState {
  let worst: ConnectionState = NOT_CHECKED;
  for (const s of states) {
    const a = SEVERITY[s.state];
    const b = SEVERITY[worst.state];
    if (a > b) worst = s;
    else if (a === b && (s.observedAt?.getTime() ?? 0) > (worst.observedAt?.getTime() ?? 0)) {
      worst = s;
    }
  }
  return worst;
}

/** Thrown where a connection cannot be used; carries the state that says why. */
export class ConnectionUnavailableError extends Error {
  readonly ref: ConnectionRef;
  readonly connection: ConnectionState;
  constructor(ref: ConnectionRef, connection: ConnectionState) {
    super(
      `connection_${connection.state}: ${connection.cause}` +
        (connection.detail ? ` (${connection.detail})` : '') +
        (connection.retryAfter
          ? `; next attempt after ${connection.retryAfter.toISOString()}`
          : ''),
    );
    this.name = 'ConnectionUnavailableError';
    this.ref = ref;
    this.connection = connection;
  }
}

// ─── Classification, by protocol ─────────────────────────────────────────────

function unreachable(
  cause: 'network' | 'timeout' | 'provider_unavailable',
  detail: string,
  now: Date,
): ConnectionState {
  return connectionState(
    'unreachable',
    cause,
    detail,
    now,
    new Date(now.getTime() + UNREACHABLE_RETRY_MS),
  );
}

/**
 * The state a token endpoint's refusal puts a credential in (RFC 6749 §5.2).
 * `invalid_grant` (the refresh token is expired, revoked or was issued to
 * another client), `invalid_client` and `unauthorized_client` mean the grant
 * no longer stands: the person must authorise again. A 5xx is the provider
 * being unavailable. Anything else the endpoint answers is a refusal too: an
 * endpoint that turns a refresh down gives no other way to obtain a token.
 */
export function tokenEndpointFailure(
  status: number,
  body: string,
  now: Date = new Date(),
): ConnectionState {
  let code: string | null = null;
  let description: string | null = null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed['error'] === 'string') code = parsed['error'];
    if (typeof parsed['error_description'] === 'string') description = parsed['error_description'];
  } catch {
    // Not JSON: the status alone speaks.
  }
  const detail = [`${status}`, code, description].filter(Boolean).join(' ');
  if (status >= 500) return unreachable('provider_unavailable', detail, now);
  return connectionState('needs_reauth', 'grant_refused', detail, now);
}

/**
 * The state an HTTP status from a provider's API says, or null when it says
 * nothing about the connection (a 404 is about the object, a 429 about the
 * pace, a 403 about one call's rights and, at some providers, a quota).
 */
export function httpFailure(
  status: number,
  message: string,
  now: Date = new Date(),
): ConnectionState | null {
  if (status === 401) {
    return connectionState('needs_reauth', 'grant_refused', `${status} ${message}`, now);
  }
  if (status >= 500 && status <= 599) {
    return unreachable('provider_unavailable', `${status} ${message}`, now);
  }
  return null;
}

// The operating system's and the fetch layer's names for "could not reach":
// identifiers, not phrasing, so a rewording never changes the answer.
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'TimeoutError',
]);
const CODE_IN_TEXT = /\b(E[A-Z]{4,}|UND_ERR_[A-Z_]+)\b/g;

function codesOf(err: unknown, depth = 0): string[] {
  if (depth > 4 || typeof err !== 'object' || err === null) return [];
  const e = err as Record<string, unknown>;
  const out: string[] = [];
  if (typeof e['code'] === 'string') out.push(e['code']);
  if (e['name'] === 'TimeoutError') out.push('TimeoutError');
  // A layer that wraps the transport error keeps its code in the text it
  // forwards ("connect ECONNREFUSED 127.0.0.1:443"): the code is read there,
  // never a phrase.
  if (typeof e['message'] === 'string') {
    out.push(...(e['message'].match(CODE_IN_TEXT) ?? []));
    // Node's fetch (undici) reports every transport failure with this one
    // fixed message, its cause holding the code. An adapter that re-wraps the
    // error keeps the message and drops the cause: the message is then the
    // only identifier left, and it is the runtime's, not a phrase of a
    // provider.
    if (e['message'] === 'fetch failed') out.push('UND_ERR_SOCKET');
  }
  return [...out, ...codesOf(e['cause'], depth + 1)];
}

/** The state a transport failure says, or null when the error is not one. */
export function networkFailure(err: unknown, now: Date = new Date()): ConnectionState | null {
  const codes = codesOf(err);
  const detail = err instanceof Error ? err.message : String(err);
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return unreachable('timeout', detail, now);
  if (codes.some((c) => NETWORK_CODES.has(c))) return unreachable('network', detail, now);
  return null;
}

/**
 * The state an error raised by a provider call says: a connection error
 * already classified, the HTTP status the error carries (every adapter error
 * keeps the provider's `status`), or a transport failure. Null when the error
 * is about the call, not the connection.
 */
export function callFailure(err: unknown, now: Date = new Date()): ConnectionState | null {
  if (err instanceof ConnectionUnavailableError) return err.connection;
  if (typeof err === 'object' && err !== null) {
    const status = (err as Record<string, unknown>)['status'];
    if (typeof status === 'number') {
      const message = err instanceof Error ? err.message : String(err);
      return httpFailure(status, message, now) ?? networkFailure(err, now);
    }
  }
  return networkFailure(err, now);
}

// ─── What the model reads ─────────────────────────────────────────────────────

/** Where the person repairs each kind of source (the dashboard's own page names). */
const REPAIRED_FROM: Record<ConnectionSourceKind, string> = {
  credential: 'the Connectors page (Reconnect)',
  connector: 'the Connectors page (Reconnect)',
  mcp_server: 'the MCP servers page',
  channel: "the agent's Channels tab",
};

function reasonForModel(c: ConnectionState): string {
  const said = c.detail ? ` (provider said: ${c.detail})` : '';
  switch (c.cause) {
    case 'grant_refused':
      return `the provider refused its authorisation${said}`;
    case 'rights_missing':
      return `its authorisation lacks rights it needs${said}`;
    case 'credential_removed':
      return 'its credential was deleted';
    case 'key_missing':
      return 'it has no key';
    case 'rotation_lost':
      return `a new token from the provider could not be stored${said}`;
    case 'no_refresh':
      return `its token expired and cannot be renewed without the person${said}`;
    case 'network':
    case 'timeout':
    case 'provider_unavailable':
      return `the provider could not be reached${said}`;
    case 'undecryptable':
      return 'its stored secret cannot be decrypted by this installation';
    case 'command_not_found':
      return `its command could not be started${said}`;
    case 'config_incomplete':
      return 'its configuration is incomplete';
    case 'not_checked':
    case 'authorised':
    case 'succeeded':
      return 'it works';
  }
}

/**
 * One sentence for the model about a connection, naming the service and the
 * account. The same sentence is the context line of a job that withholds the
 * source and the tail of a tool's error, so the agent reads one account of it.
 */
export function connectionNoteForModel(
  subject: { label: string; account?: string | null; kind: ConnectionSourceKind },
  connection: ConnectionState,
): string {
  const who = subject.account ? `${subject.label} (account "${subject.account}")` : subject.label;
  const reason = reasonForModel(connection);
  if (connection.state === 'working') return `${who} works.`;
  if (connection.state === 'unreachable') {
    const when = connection.retryAfter
      ? ` Next attempt after ${connection.retryAfter.toISOString()}.`
      : '';
    return `${who} is unreachable: ${reason}.${when}`;
  }
  return (
    `${who} is attached but disconnected: ${reason}. No call to it can succeed until the person ` +
    `repairs it from ${REPAIRED_FROM[subject.kind]}; tell them so instead of trying another way.`
  );
}

/**
 * The state of a connector, from the facts of its rows: whether it has the
 * secret it needs (its credential, for OAuth; its key, for an API key) and
 * whether that secret can be read, then what was learnt about the rows it
 * uses (the credential's state, the connector's own). The one combination the
 * job, the dashboard and the agent's context apply.
 */
export function connectorConnection(facts: {
  secretKind: 'credential' | 'api_key';
  secret: 'absent' | 'unreadable' | 'readable';
  stored: readonly ConnectionState[];
}): ConnectionState {
  const fact = (state: ConnectionStateKind, cause: ConnectionCause): ConnectionState => ({
    state,
    cause,
    detail: null,
    observedAt: null,
    retryAfter: null,
  });
  if (facts.secret === 'absent') {
    return fact(
      'needs_reauth',
      facts.secretKind === 'credential' ? 'credential_removed' : 'key_missing',
    );
  }
  if (facts.secret === 'unreadable') return fact('broken', 'undecryptable');
  return worstConnection(...facts.stored);
}
