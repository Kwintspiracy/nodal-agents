// connector-contract.ts — what a connector tool may return, and how it fails.
//
// A connector tool is a name, a schema and a function. What it returns and
// how it behaves is written HERE, once, for every adapter: the registry
// (runner-adapters) holds every connector tool to it, and the conformance
// suite (test-kit connector-contract-suite.ts) measures every operation of
// every adapter against it.
//
//   A list    has one shape, `{ items, next, truncated, total? }`, and takes
//             `cursor`: `next` passed back as `cursor` reads on; `total` is
//             the provider's own count of everything, or absent (never the
//             length of one page).
//   A cut     is stated: `truncated` says how many items were shown and how
//             to read the rest. Nothing is dropped in silence.
//   A failure is one kind of a closed set (`CONNECTOR_ERROR_KINDS`, with the
//             mapping in connection-state.ts), with the provider's retry
//             time when it gave one and the provider's own answer untouched.
//   A call    receives the job's stop signal and a time bound, both passed to
//             the provider's client through the transport the registry gives
//             the adapter.
//   A write   whose request left and whose answer never came says its outcome
//             is unknown (`mayHaveDelivered`, the flag the tool seam reads):
//             the model is told not to send it again.

import {
  markClassified,
  type CallFailureClass,
  type ConnectionState,
  type ConnectorErrorKind,
  type ProviderAnswer,
} from './connection-state';

export { CONNECTOR_ERROR_KINDS } from './connection-state';
export type { ConnectorErrorKind, ProviderAnswer, CallFailureClass } from './connection-state';

// ─── Lists ────────────────────────────────────────────────────────────────────

/** Why a result holds fewer items than the provider had. */
export type ConnectorCutReason =
  /** The items would not fit the result the model reads (`TOOL_RESULT_MODEL_CHARS`). */
  | 'result_budget'
  /** The provider itself stopped (a cap on what one request may return). */
  | 'provider_cap';

/** A cut, stated: what was shown, and how to read the rest. */
export interface ConnectorCut {
  readonly reason: ConnectorCutReason;
  /** Items shown in this result. */
  readonly shown: number;
  /** Items the page held, when known. */
  readonly of: number | null;
  /** How to read the rest, for the model. */
  readonly readMore: string;
}

/** The one shape of a list result. */
export interface ConnectorList<T = unknown> {
  readonly items: readonly T[];
  /** Pass back as `cursor` to read on; null when there is nothing more. */
  readonly next: string | null;
  /** Null when nothing was cut. */
  readonly truncated: ConnectorCut | null;
  /** The provider's own count of every item, when it gives one. Never a page's length. */
  readonly total?: number;
}

/** The input argument every list takes. */
export const LIST_CURSOR_KEY = 'cursor';

/** What the model reads of the `cursor` argument. */
export const LIST_CURSOR_DESCRIPTION =
  'Leave empty for the first page. To read on, pass the `next` value of the previous result.';

/** Whether `value` has the list shape. */
export function isConnectorList(value: unknown): value is ConnectorList {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v['items']) &&
    (v['next'] === null || typeof v['next'] === 'string') &&
    (v['truncated'] === null || (typeof v['truncated'] === 'object' && v['truncated'] !== null)) &&
    (v['total'] === undefined || typeof v['total'] === 'number')
  );
}

// The cursor the shared layer hands out when it cuts a page: the provider's
// cursor of that page, and how many of its items were already shown. Opaque
// to the model; an adapter only ever sees the provider's own cursor.
const RESUME_PREFIX = 'nodal-resume:';

/** A cursor that resumes inside a page: its provider cursor, and the items already shown. */
export interface ResumeCursor {
  readonly provider: string | null;
  readonly skip: number;
}

export function encodeResumeCursor(c: ResumeCursor): string {
  return RESUME_PREFIX + Buffer.from(JSON.stringify([c.provider, c.skip])).toString('base64url');
}

/**
 * The provider cursor and the items to skip that a `cursor` argument names.
 * A cursor that is not a resume cursor is the provider's own (skip 0).
 */
export function decodeCursor(cursor: string | undefined | null): ResumeCursor {
  if (!cursor) return { provider: null, skip: 0 };
  if (!cursor.startsWith(RESUME_PREFIX)) return { provider: cursor, skip: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(RESUME_PREFIX.length), 'base64url').toString());
  } catch {
    throw new ConnectorCallError(
      {
        kind: 'invalid_input',
        status: null,
        providerCode: null,
        retryAfter: null,
        connection: null,
      },
      'invalid_input: `cursor` is not a value this tool returned as `next`',
      null,
    );
  }
  const [provider, skip] = Array.isArray(parsed) ? parsed : [];
  if (!(provider === null || typeof provider === 'string') || !Number.isInteger(skip) || skip < 0) {
    throw new ConnectorCallError(
      {
        kind: 'invalid_input',
        status: null,
        providerCode: null,
        retryAfter: null,
        connection: null,
      },
      'invalid_input: `cursor` is not a value this tool returned as `next`',
      null,
    );
  }
  return { provider: provider as string | null, skip: skip as number };
}

// ─── Failures ─────────────────────────────────────────────────────────────────

/**
 * A connector call's failure, as the model and the runner read it. Its
 * `message` starts with the kind; `cause` is what the adapter threw,
 * untouched; `providerAnswer` is what the provider answered, untouched, when
 * the adapter's transport is the contract's.
 */
export class ConnectorCallError extends Error {
  readonly failure: CallFailureClass;
  readonly kind: ConnectorErrorKind | 'stopped';
  readonly status: number | null;
  readonly providerCode: string | null;
  readonly retryAfter: Date | null;
  readonly connection: ConnectionState | null;
  readonly providerAnswer: ProviderAnswer | null;
  /** The call's bound, when it is what ended the call. */
  readonly boundMs: number | null;
  /**
   * The request of a write left and no answer came: the provider may have
   * acted on it. Read by the tool seam (`executeTool`), which tells the model
   * not to call again.
   */
  readonly mayHaveDelivered: true | undefined;

  constructor(
    failure: CallFailureClass,
    message: string,
    providerAnswer: ProviderAnswer | null,
    options: {
      cause?: unknown;
      boundMs?: number | null;
      mayHaveDelivered?: boolean;
      stopped?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConnectorCallError';
    this.failure = failure;
    this.kind = options.stopped ? 'stopped' : failure.kind;
    this.status = failure.status;
    this.providerCode = failure.providerCode;
    this.retryAfter = failure.retryAfter;
    this.connection = failure.connection;
    this.providerAnswer = providerAnswer;
    this.boundMs = options.boundMs ?? null;
    this.mayHaveDelivered = options.mayHaveDelivered ? true : undefined;
    markClassified(this);
  }
}

/** The message of a contract failure: the kind first, then what the provider or the adapter said. */
export function connectorFailureMessage(
  kind: ConnectorErrorKind | 'stopped',
  said: string,
  facts: { retryAfter: Date | null; boundMs: number | null },
): string {
  const parts = [`${kind}: ${said}`];
  if (kind === 'rate_limited') {
    parts.push(
      facts.retryAfter
        ? `The provider asks to try again after ${facts.retryAfter.toISOString()}.`
        : 'The provider gave no time to try again.',
    );
  } else if (kind === 'temporary' && facts.retryAfter) {
    parts.push(`The provider asks to try again after ${facts.retryAfter.toISOString()}.`);
  }
  if (facts.boundMs !== null) {
    parts.push(`No answer came within the call's bound of ${facts.boundMs} ms.`);
  }
  return parts.join(' ');
}
