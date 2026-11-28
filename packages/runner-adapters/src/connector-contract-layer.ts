// connector-contract-layer.ts — the connector contract, enforced once for every adapter.
//
// The registry wraps every connector tool it hands out (`holdToContract`) and
// gives every adapter factory one transport (`contractTransport`), a `fetch`
// the adapter passes to its provider's SDK. What follows is then true of
// every call of every operation, whether or not its adapter was ever touched:
//
//   bound    the call ends within its operation's time bound
//            (`OperationDescriptor.timeBoundMs`, else DEFAULT_CALL_BOUND_MS),
//            failing as `temporary` with the bound named;
//   stop     the job's stop signal ends the call at once (`stopped`);
//   signal   the adapter receives, as `ctx.signal`, one signal that aborts on
//            either; through the transport, every provider request of the
//            call is aborted with it, even when the adapter never reads it;
//   failure  whatever the adapter throws becomes a `ConnectorCallError` of
//            the closed set (connection-state.ts `classifyCallFailure`), its
//            `cause` the adapter's error untouched and its `providerAnswer`
//            the provider's error answer as the transport received it;
//   unknown  a write whose request left and whose answer never came (a
//            non-safe method in flight when the call was cut, or failed
//            without an answer and not before leaving) carries
//            `mayHaveDelivered`, the flag the tool seam already reads
//            (`executeTool`): the model is told not to send it again;
//   lists    an operation declared `returns: 'list'` returns
//            `{ items, next, truncated, total? }`; a page too large for the
//            result budget is cut on whole items, the cut stated, and `next`
//            resumes at the first item not shown.
//
// Nothing here retries: a refusal goes back with its kind and its retry time.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  classifyCallFailure,
  connectorFailureMessage,
  ConnectorCallError,
  decodeCursor,
  encodeResumeCursor,
  isConnectorList,
  neverSent,
  networkFailure,
  LIST_CURSOR_KEY,
  TOOL_RESULT_MODEL_CHARS,
  type ConnectorList,
  type OperationDescriptor,
  type ProviderAnswer,
} from '@nodal-agents/shared';
import type { ToolContext, ToolDefinition } from '@nodal-agents/tools';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

/** The bound of a call whose operation declares none. */
export const DEFAULT_CALL_BOUND_MS = 120_000;

/** RFC 9110 §9.2.1: methods that cannot have an effect at the provider. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** The most of an error answer's body kept (error bodies are short; this bounds a wrong one). */
const ANSWER_BODY_CHARS = 16_384;

/**
 * Room a list result keeps below the budget: the frame of a third party's
 * result and the account wrapper of a multi-account tool (tool-sources.ts).
 */
const LIST_RESULT_MARGIN = 2_000;

interface RequestRecord {
  readonly method: string;
  state: 'pending' | 'answered' | 'failed';
  /** Failed after it may have left (not a connection that was never made). */
  mayHaveLeft: boolean;
}

interface CallRecord {
  readonly signal: AbortSignal;
  readonly requests: RequestRecord[];
  /** The provider's last error answer in this call, and whether a later answer succeeded. */
  lastErrorAnswer: ProviderAnswer | null;
}

const calls = new AsyncLocalStorage<CallRecord>();

function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function methodOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input) {
    return String((input as Request).method).toUpperCase();
  }
  return 'GET';
}

/**
 * The transport every adapter is given: `base` (the process's `fetch`
 * unless a test passes a fake provider), with the call's signal joined to the
 * SDK's own and every answer recorded for the call it belongs to. Outside a
 * contract call (an adapter's own set-up) it is `base` unchanged.
 */
export function contractTransport(base: () => typeof fetch): typeof fetch {
  const transport = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const call = calls.getStore();
    if (!call) return base()(input, init);
    const own =
      init?.signal ??
      (typeof input === 'object' && input !== null && 'signal' in input
        ? (input as Request).signal
        : null);
    const signal = own ? AbortSignal.any([own, call.signal]) : call.signal;
    const record: RequestRecord = {
      method: methodOf(input, init),
      state: 'pending',
      mayHaveLeft: false,
    };
    call.requests.push(record);
    // A call already cut or stopped sends nothing more (an adapter that
    // swallowed the first abort must not start a write after it).
    if (call.signal.aborted) {
      record.state = 'failed';
      throw call.signal.reason;
    }
    let response: Response;
    try {
      response = await base()(input, { ...init, signal });
    } catch (err) {
      record.state = 'failed';
      record.mayHaveLeft = !neverSent(err);
      throw err;
    }
    record.state = 'answered';
    if (response.ok) {
      call.lastErrorAnswer = null;
    } else {
      let body = '';
      try {
        body = (await response.clone().text()).slice(0, ANSWER_BODY_CHARS);
      } catch {
        // The body could not be read: the status and headers remain.
      }
      call.lastErrorAnswer = {
        status: response.status,
        headers: headersOf(response.headers),
        body,
      };
    }
    return response;
  };
  return transport as typeof fetch;
}

/** What the registry gives one adapter factory, and the bound a test may impose. */
export interface ContractOptions {
  /** The provider's transport under the contract's; the process's `fetch` when absent. */
  fetch?: typeof fetch;
  /** Every call's bound, replacing each operation's (tests only: the runner passes none). */
  boundMs?: number;
}

/** How an adapter's source declares its transport. */
export interface ContractSource {
  /** The factory hands the transport it is given to its provider's SDK. */
  readonly passesTransport: boolean;
}

/**
 * The idempotency key of a write, derived from the tool-call id: the same for
 * every request the call makes (an SDK's own retry), different for every call.
 * Base32hex (RFC 4648 §7), lower case, so it fits the strictest of the
 * providers that take a client key (an event id: [a-v0-9], 5 to 1024 chars).
 */
export function idempotencyKeyFor(toolCallId: string, operation: string): string {
  const digest = createHash('sha256').update(`${operation}\u0000${toolCallId}`).digest();
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 32);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The items of `list` that fit the result budget, whole, at least one. */
function fitItems(list: ConnectorList, extra: Record<string, unknown>): number {
  const room = TOOL_RESULT_MODEL_CHARS - LIST_RESULT_MARGIN;
  const frame = JSON.stringify({
    ...extra,
    items: [],
    next: 'x'.repeat(120),
    truncated: { readMore: 'x'.repeat(200) },
  }).length;
  let used = frame;
  let n = 0;
  for (const item of list.items) {
    used += JSON.stringify(item).length + 1;
    if (used > room) break;
    n += 1;
  }
  return Math.max(1, n);
}

/** A list result as the contract returns it: resumed where `skip` says, cut to the budget. */
function shapeList(
  op: OperationDescriptor,
  out: unknown,
  providerCursor: string | null,
  skip: number,
): ConnectorList {
  if (!isConnectorList(out)) {
    throw new Error(
      `connector contract: operation '${op.slug}' is declared a list and returned another shape ` +
        '(expected { items, next, truncated })',
    );
  }
  const items = out.items.slice(skip);
  const rest = { ...out, items };
  if (JSON.stringify(rest).length <= TOOL_RESULT_MODEL_CHARS - LIST_RESULT_MARGIN) return rest;
  const { items: _all, next: _next, truncated: _truncated, ...extra } = rest;
  const shown = fitItems(rest, extra);
  if (shown >= items.length) return rest;
  return {
    ...extra,
    items: items.slice(0, shown),
    next: encodeResumeCursor({ provider: providerCursor, skip: skip + shown }),
    truncated: {
      reason: 'result_budget',
      shown,
      of: items.length,
      readMore:
        `Only ${shown} of the ${items.length} items of this page fit in one result. ` +
        `Call again with \`${LIST_CURSOR_KEY}\` set to \`next\` to read the rest.`,
    },
  };
}

class CallCut extends Error {
  constructor(readonly stopped: boolean) {
    super(stopped ? 'stopped' : 'bound');
  }
}

/**
 * The tool the registry hands out: `tool` held to the contract (see the head
 * of this file). `op` is its descriptor, already bound (its risk is the one
 * the gate reads).
 */
export function holdToContract(
  tool: AnyTool,
  op: OperationDescriptor,
  source: ContractSource,
  options: ContractOptions,
): AnyTool {
  const execute = tool.execute.bind(tool) as AnyTool['execute'];
  const boundMs = options.boundMs ?? op.timeBoundMs ?? DEFAULT_CALL_BOUND_MS;
  const isWrite = op.risk !== 'read';
  const isList = op.returns === 'list';
  if (isList) {
    const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
    if (!shape || !(LIST_CURSOR_KEY in shape)) {
      throw new Error(
        `connector contract: operation '${op.slug}' is declared a list, but its input takes ` +
          `no \`${LIST_CURSOR_KEY}\` to read further`,
      );
    }
  }
  // Whether the transport's records say everything a call did at the provider.
  const seesEveryRequest = source.passesTransport && op.effectOutsideTransport !== true;

  const wrapped: AnyTool['execute'] = async (input, ctx: ToolContext) => {
    const bound = AbortSignal.timeout(boundMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, bound]) : bound;
    const record: CallRecord = { signal, requests: [], lastErrorAnswer: null };

    let callInput = input;
    let providerCursor: string | null = null;
    let skip = 0;
    if (isList && typeof input === 'object' && input !== null) {
      const given = (input as Record<string, unknown>)[LIST_CURSOR_KEY];
      const resume = decodeCursor(typeof given === 'string' ? given : null);
      providerCursor = resume.provider;
      skip = resume.skip;
      const { [LIST_CURSOR_KEY]: _cursor, ...rest } = input as Record<string, unknown>;
      callInput = (
        providerCursor === null ? rest : { ...rest, [LIST_CURSOR_KEY]: providerCursor }
      ) as typeof input;
    }

    const callCtx: ToolContext = {
      ...ctx,
      signal,
      ...(isWrite && ctx.toolCallId
        ? { idempotencyKey: idempotencyKeyFor(ctx.toolCallId, op.slug) }
        : {}),
    };
    const running = calls.run(record, () => execute(callInput, callCtx));
    // The adapter may settle after the call was cut; its outcome is then nobody's.
    running.catch(() => undefined);
    let onAbort: (() => void) | null = null;
    const cut = new Promise<never>((_, reject) => {
      onAbort = () => reject(new CallCut(ctx.signal?.aborted === true));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    cut.catch(() => undefined);
    try {
      const out = await Promise.race([running, cut]);
      return isList ? shapeList(op, out, providerCursor, skip) : out;
    } catch (err) {
      throw contractFailure(err, record, {
        boundMs,
        isWrite,
        seesEveryRequest,
        jobSignal: ctx.signal ?? null,
      });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
  return { ...tool, execute: wrapped };
}

/** What a failed call becomes under the contract. */
function contractFailure(
  err: unknown,
  record: CallRecord,
  facts: {
    boundMs: number;
    isWrite: boolean;
    seesEveryRequest: boolean;
    jobSignal: AbortSignal | null;
  },
): unknown {
  if (err instanceof ConnectorCallError) return err;
  const cut = err instanceof CallCut || record.signal.aborted;
  const stopped = cut && facts.jobSignal?.aborted === true;
  const nonSafe = record.requests.filter((r) => !SAFE_METHODS.has(r.method));
  // Whether a write may have reached the provider without its answer coming back.
  const writeLeft = facts.seesEveryRequest
    ? nonSafe.some((r) => r.state === 'pending' || (r.state === 'failed' && r.mayHaveLeft))
    : // A call whose effect the transport does not see: a cut, or a transport
      // failure that may have come after sending, leaves its outcome unknown.
      cut || (networkFailure(err) !== null && !neverSent(err));
  const mayHaveDelivered = facts.isWrite && writeLeft;
  const adapterError = err instanceof CallCut ? null : err;

  if (cut) {
    const failure = {
      kind: 'temporary' as const,
      status: null,
      providerCode: null,
      retryAfter: null,
      connection: null,
    };
    const said = stopped ? "the job's stop ended this call" : 'the provider did not answer in time';
    return new ConnectorCallError(
      failure,
      connectorFailureMessage(stopped ? 'stopped' : 'temporary', said, {
        retryAfter: null,
        boundMs: stopped ? null : facts.boundMs,
      }),
      null,
      {
        ...(adapterError !== null ? { cause: adapterError } : {}),
        boundMs: stopped ? null : facts.boundMs,
        mayHaveDelivered,
        stopped,
      },
    );
  }

  const answer = record.lastErrorAnswer;
  const failure = classifyCallFailure(err, answer);
  return new ConnectorCallError(
    failure,
    connectorFailureMessage(failure.kind, messageOf(err), {
      retryAfter: failure.retryAfter,
      boundMs: null,
    }),
    answer,
    { cause: err, mayHaveDelivered },
  );
}
