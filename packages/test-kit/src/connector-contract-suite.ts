// @nodal-agents/test-kit — the connector contract's conformance suite (#1185).
//
// What a connector tool may return and how it behaves is written once
// (@nodal-agents/shared connector-contract.ts) and enforced once, where the
// registry assembles every connector tool (runner-adapters). This suite holds
// EVERY operation of EVERY adapter to it, table-driven over the registry:
// each adapter is given a fake provider as its `fetch`, and each rule is one
// scenario of that provider (it never answers; it refuses for pace in each
// form the provider uses; it answers an error; it serves three pages). The
// assertions are on what the provider received (the request, its abort) and
// on what the tool returned or threw, never on call counts.
//
// Chapters. The mail contract (mail-contract-suite.ts, `MAIL_CONTRACT_CASES`)
// is the first chapter: what send, reply, reply-all and forward mean, run per
// mail adapter with its own driver. This file is the transport chapter: what
// every call of every operation does with a list, a refusal, a stop, a bound,
// a cut and a write whose answer never came.
//
// The ratchet. An operation that does not conform yet, and cannot from the
// shared layer, is listed with the rules it breaks. The suite compares what
// it measured with that list both ways: an operation that starts conforming
// turns the suite red until its entry is removed, one that stops conforming
// turns it red because it is not listed, and an adapter that did not exist
// when the list was frozen cannot be listed at all.
//
// A connection that leaves this machine is refused by the network guard
// (no-network.ts): an adapter that does not use the `fetch` it is given
// reaches the guard instead of the fake, which this suite records as the
// `transport` rule broken (inside `withNetworkScope`, so it does not also fail
// the file), and the guard then stands in for a provider that never answers.
//
// This harness imports no product package (dependency-cruiser rule
// `adapters-only-import-tools-shared`): its types mirror the contract's
// structurally.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withNetworkScope } from './no-network.ts';
import type { NetworkAttempt, NetworkScopeMode } from './no-network.ts';

// ── The rules ───────────────────────────────────────────────────────────────

export const CONNECTOR_CONTRACT_RULES = [
  /** Every request of the call goes through the `fetch` the shared layer gives the adapter. */
  'transport',
  /** Aborting the job's signal aborts the provider request within a second, and ends the call. */
  'signal',
  /** A call that exceeds its bound fails as `temporary`, naming the bound. */
  'bound',
  /** A pace refusal, in every form the provider uses, is `rate_limited` with its retry time. */
  'rate_limited',
  /** The provider's own answer (status, body) is in the error, untouched. */
  'cause',
  /**
   * A write whose request left and whose answer never came says its outcome
   * is unknown (`mayHaveDelivered`); a read, or a write that sent nothing, never does.
   */
  'unknown_outcome',
  /** A list reads a three-page provider fixture in three calls, through `cursor`. */
  'list',
  /** A list result larger than the result budget says it was cut, and `next` reads the rest. */
  'cut',
] as const;
export type ContractRule = (typeof CONNECTOR_CONTRACT_RULES)[number];

// ── What a run is given ─────────────────────────────────────────────────────

/** A tool as the registry hands it to a job (structural). */
export interface ContractTool {
  name: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: never, ctx: never) => Promise<unknown>;
}

/** An operation of an adapter, as its descriptor declares it. */
export interface ContractOperation {
  slug: string;
  risk: 'read' | 'write' | 'destructive';
  /** `list` when the descriptor declares the contract's list shape. */
  returns?: 'list';
  /**
   * The operation reads a provider collection page by page, declared or not:
   * the table's own statement (its run file), so that a list not yet in the
   * contract's shape is measured as breaking the list rules.
   */
  isList?: true;
  /** The descriptor says its effect is carried out outside the transport (a child process). */
  effectOutsideTransport?: true;
}

/** A provider's answers for the refusal scenarios, in its own error format. */
export interface ProviderFixture {
  /** The provider family, for the report (e.g. 'AIP-193 JSON', 'Graph', 'Notion'). */
  family: string;
  /**
   * Every form in which this provider refuses for pace: the status it uses,
   * and the retry time it gives (seconds, or null when it gives none).
   */
  rateLimit: ReadonlyArray<{
    label: string;
    retryAfterSeconds: number | null;
    answer: () => Response;
  }>;
  /** An error answer of `status` whose body carries `marker`, in the provider's format. */
  error: (status: number, marker: string) => Response;
}

/** A list operation's provider fixture: pages the fake serves, by the provider's own cursor. */
export interface ListFixture {
  /** The ids of the items of each of the three pages the provider holds. */
  pages: readonly [readonly string[], readonly string[], readonly string[]];
  /** The provider's answer to `request`, given the pages it holds. */
  answer: (
    request: Request,
    pages: readonly (readonly string[])[],
    bigItems: boolean,
  ) => Promise<Response> | Response;
  /** The id of an item of the tool's result. */
  idOf: (item: unknown) => string;
}

export interface ContractAdapter {
  /** The registry slug. */
  slug: string;
  operations: readonly ContractOperation[];
  /** The adapter's tools as the registry assembles them for a job, over `fetch`. */
  build: (io: { fetch: typeof fetch; boundMs: number }) => readonly ContractTool[];
  provider: ProviderFixture;
  /** An input of `operation` that its schema accepts and that reaches the provider. */
  sampleInput: (operation: string) => unknown;
  /** What a call of `operation` needs in its context beyond the job's ids (a workspace). */
  sampleContext?: (operation: string) => Record<string, unknown>;
  /** Required for every operation declared `list`. */
  listFixtures?: Readonly<Record<string, ListFixture>>;
}

/** Operations that do not conform yet, by adapter then operation, with the rules each breaks. */
export type ContractRatchet = Readonly<
  Record<string, Readonly<Record<string, readonly ContractRule[]>>>
>;

// ── Timing ──────────────────────────────────────────────────────────────────

/** The bound the suite gives a call whose provider never answers. */
export const SUITE_BOUND_MS = 400;
/** The bound for the refusal scenarios, where an SDK's own back-off may run first. */
export const SUITE_ANSWER_BOUND_MS = 15_000;
/** How long after the job's stop the request must be aborted (the contract's "within a second"). */
export const STOP_WITHIN_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── The fake provider ───────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface SeenRequest {
  method: string;
  url: string;
  abortedAt: number | null;
  answered: boolean;
}

interface FakeProvider {
  fetch: typeof fetch;
  seen: SeenRequest[];
}

function requestOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Request {
  return new Request(input as string | URL | Request, init);
}

/** A provider that never answers: each request waits until its signal aborts. */
function silentProvider(): FakeProvider {
  const seen: SeenRequest[] = [];
  const fake = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = requestOf(input, init);
    const signal = init?.signal ?? null;
    // An aborted signal: fetch refuses before anything is sent.
    if (signal?.aborted) return Promise.reject(signal.reason);
    const entry: SeenRequest = {
      method: req.method,
      url: req.url,
      abortedAt: null,
      answered: false,
    };
    seen.push(entry);
    return new Promise<Response>((_, reject) => {
      const onAbort = () => {
        entry.abortedAt = Date.now();
        reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  return { fetch: fake, seen };
}

/** A provider that answers every request with `answer()`. */
function answeringProvider(answer: (req: Request) => Promise<Response> | Response): FakeProvider {
  const seen: SeenRequest[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = requestOf(input, init);
    const entry: SeenRequest = {
      method: req.method,
      url: req.url,
      abortedAt: null,
      answered: true,
    };
    seen.push(entry);
    return answer(req);
  }) as typeof fetch;
  return { fetch: fake, seen };
}

// ── One call ────────────────────────────────────────────────────────────────

interface CallOutcome {
  settled: PromiseSettledResult<unknown>;
  /** Connections that reached the network guard instead of the fake. */
  escaped: readonly NetworkAttempt[];
  /** When the call settled (null: still pending when the suite gave up). */
  endedAt: number | null;
}

function contextFor(signal: AbortSignal, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    jobId: 'job-contract-suite',
    agentId: 'agent-contract-suite',
    entityId: 'entity-contract-suite',
    db: null,
    jobChatId: null,
    signal,
    toolCallId: 'call-contract-suite-1',
  };
}

function toolOf(adapter: ContractAdapter, provider: FakeProvider, boundMs: number, op: string) {
  const tool = adapter.build({ fetch: provider.fetch, boundMs }).find((t) => t.name === op);
  if (!tool) throw new Error(`${adapter.slug}: the registry builds no tool named "${op}"`);
  return tool;
}

/**
 * Run one call, awaited at most `waitMs`. `during` runs while it is pending
 * (to stop the job), with the connections that reached the guard so far.
 * `mode`: what the guard does with such a connection (`hold`: a provider
 * that never answers; `refuse`: a connection that fails at once).
 */
async function runCall(
  label: string,
  extra: Record<string, unknown>,
  tool: ContractTool,
  input: unknown,
  job: AbortController,
  waitMs: number,
  mode: NetworkScopeMode,
  during?: (escaped: readonly NetworkAttempt[]) => Promise<void>,
): Promise<CallOutcome> {
  let endedAt: number | null = null;
  const { outcome, attempts } = await withNetworkScope(
    label,
    async (live) => {
      const call = (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(
        input,
        contextFor(job.signal, extra),
      );
      const settled = call.then(
        (value) => {
          endedAt = Date.now();
          return { status: 'fulfilled', value } as const;
        },
        (reason: unknown) => {
          endedAt = Date.now();
          return { status: 'rejected', reason } as const;
        },
      );
      if (during) void during(live);
      const result = await Promise.race([settled, delay(waitMs).then(() => null)]);
      if (result === null) {
        // A call left pending is stopped, so no timer of it outlives the case.
        job.abort(new Error('the suite ended this call'));
        return {
          status: 'rejected',
          reason: new Error(`call still pending after ${waitMs} ms`),
        } as const;
      }
      return result;
    },
    mode,
  );
  const settled =
    outcome.status === 'fulfilled'
      ? (outcome.value as PromiseSettledResult<unknown>)
      : ({ status: 'rejected', reason: outcome.reason } as const);
  return { settled, escaped: attempts, endedAt };
}

function errorField(reason: unknown, field: string): unknown {
  return typeof reason === 'object' && reason !== null
    ? (reason as Record<string, unknown>)[field]
    : undefined;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function waitUntil(test: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return true;
    await delay(10);
  }
  return test();
}

// ── Evaluating one operation ────────────────────────────────────────────────

export interface RuleFinding {
  rule: ContractRule;
  /** What was measured, when the rule is broken. */
  detail: string;
}

export interface OperationResult {
  adapter: string;
  operation: string;
  broken: RuleFinding[];
  /** The sample input never reached the provider: the table must be fixed, not the adapter. */
  unusableSample: string | null;
}

/**
 * Measure every rule on one operation. Each rule is its own scenario with its
 * own fresh tools, so no state crosses rules.
 */
export async function evaluateOperation(
  adapter: ContractAdapter,
  op: ContractOperation,
): Promise<OperationResult> {
  const broken: RuleFinding[] = [];
  const breaks = (rule: ContractRule, detail: string) => {
    if (!broken.some((b) => b.rule === rule)) broken.push({ rule, detail });
  };
  const input = adapter.sampleInput(op.slug);
  const extra = adapter.sampleContext?.(op.slug) ?? {};
  const label = `${adapter.slug}/${op.slug}`;

  // Probe: does the sample input pass the tool's schema?
  const probeTool = toolOf(adapter, silentProvider(), SUITE_BOUND_MS, op.slug);
  const parsed = probeTool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      adapter: adapter.slug,
      operation: op.slug,
      broken: [],
      unusableSample: `the sample input does not pass the schema: ${parsed.error.message}`,
    };
  }
  const sample = parsed.data as unknown;

  // 1. transport + signal: the provider never answers; the job is stopped once a request is out.
  {
    const provider = silentProvider();
    const tool = toolOf(adapter, provider, SUITE_ANSWER_BOUND_MS, op.slug);
    const job = new AbortController();
    let stoppedAt: number | null = null;
    const out = await runCall(
      `${label}#signal`,
      extra,
      tool,
      sample,
      job,
      SUITE_ANSWER_BOUND_MS,
      'hold',
      async (escaped) => {
        // A request is out when the fake saw it, or when a connection reached the guard.
        const sent = await waitUntil(() => provider.seen.length > 0 || escaped.length > 0, 3_000);
        if (!sent) return;
        await delay(50);
        stoppedAt = Date.now();
        job.abort(new Error('the job was stopped'));
      },
    );
    if (stoppedAt === null) {
      return {
        adapter: adapter.slug,
        operation: op.slug,
        broken: [],
        unusableSample: `no request reached the provider (${
          out.settled.status === 'rejected'
            ? messageOf(out.settled.reason).slice(0, 200)
            : 'the call returned without one'
        })`,
      };
    }
    const stop: number = stoppedAt;
    if (out.escaped.length > 0) {
      breaks(
        'transport',
        `${out.escaped.length} connection(s) reached the network instead of the given fetch`,
      );
    }
    const open = [
      ...provider.seen.filter(
        (r) => !r.answered && (r.abortedAt === null || r.abortedAt - stop > STOP_WITHIN_MS),
      ),
      ...out.escaped.filter((x) => x.closedAt === null || x.closedAt - stop > STOP_WITHIN_MS),
    ];
    if (open.length > 0) {
      breaks(
        'signal',
        `${open.length} request(s) still open ${STOP_WITHIN_MS} ms after the job's stop`,
      );
    } else if (out.endedAt === null || out.endedAt - stop > STOP_WITHIN_MS) {
      breaks('signal', "the call did not end within a second of the job's stop");
    }
  }

  // 2. bound + unknown outcome: the provider never answers, nobody stops the job.
  {
    const provider = silentProvider();
    const tool = toolOf(adapter, provider, SUITE_BOUND_MS, op.slug);
    const out = await runCall(
      `${label}#bound`,
      extra,
      tool,
      sample,
      new AbortController(),
      SUITE_BOUND_MS + 5_000,
      'hold',
    );
    if (out.settled.status !== 'rejected' || out.endedAt === null) {
      breaks('bound', `the call did not fail within its bound of ${SUITE_BOUND_MS} ms`);
    } else {
      const reason = out.settled.reason;
      const kind = errorField(reason, 'kind');
      if (kind !== 'temporary' || !messageOf(reason).includes(`${SUITE_BOUND_MS} ms`)) {
        breaks(
          'bound',
          `failed as ${String(kind)} without naming the bound: ${messageOf(reason).slice(0, 160)}`,
        );
      }
      // The guard sees no method: a held connection may carry a write.
      const writeOut =
        provider.seen.some((r) => !SAFE_METHODS.has(r.method) && !r.answered) ||
        out.escaped.length > 0 ||
        op.effectOutsideTransport === true;
      const expected = op.risk !== 'read' && writeOut;
      const flagged = errorField(reason, 'mayHaveDelivered') === true;
      if (flagged !== expected) {
        breaks(
          'unknown_outcome',
          expected
            ? 'a write whose request left and got no answer was reported as a plain failure'
            : 'the outcome was called unknown although no write request left',
        );
      }
    }
  }

  // 3. rate limit, in every form the provider uses.
  for (const form of adapter.provider.rateLimit) {
    const provider = answeringProvider(() => form.answer());
    const tool = toolOf(adapter, provider, SUITE_ANSWER_BOUND_MS, op.slug);
    const before = Date.now();
    const out = await runCall(
      `${label}#rate:${form.label}`,
      extra,
      tool,
      sample,
      new AbortController(),
      SUITE_ANSWER_BOUND_MS + 5_000,
      'refuse',
    );
    if (out.escaped.length > 0 || out.settled.status !== 'rejected') {
      breaks('rate_limited', `${form.label}: the refusal never reached the adapter as an error`);
      continue;
    }
    const reason = out.settled.reason;
    const kind = errorField(reason, 'kind');
    const retryAfter = errorField(reason, 'retryAfter');
    if (kind !== 'rate_limited') {
      breaks(
        'rate_limited',
        `${form.label}: came back as ${String(kind)}: ${messageOf(reason).slice(0, 160)}`,
      );
      continue;
    }
    if (form.retryAfterSeconds === null) {
      if (retryAfter !== null)
        breaks('rate_limited', `${form.label}: a retry time the provider never gave`);
    } else {
      const expectAt = before + form.retryAfterSeconds * 1000;
      if (!(retryAfter instanceof Date) || Math.abs(retryAfter.getTime() - expectAt) > 30_000) {
        breaks(
          'rate_limited',
          `${form.label}: the provider's retry time (${form.retryAfterSeconds} s) is not in the error`,
        );
      }
    }
  }

  // 4. the provider's cause.
  {
    const marker = `provider-cause-${op.slug}`;
    const provider = answeringProvider(() => adapter.provider.error(404, marker));
    const tool = toolOf(adapter, provider, SUITE_ANSWER_BOUND_MS, op.slug);
    const out = await runCall(
      `${label}#cause`,
      extra,
      tool,
      sample,
      new AbortController(),
      SUITE_ANSWER_BOUND_MS + 5_000,
      'refuse',
    );
    if (out.escaped.length > 0 || out.settled.status !== 'rejected') {
      breaks('cause', "the provider's error never reached the adapter");
    } else {
      const reason = out.settled.reason;
      const answer = errorField(reason, 'providerAnswer') as
        | { status?: unknown; body?: unknown }
        | null
        | undefined;
      if (
        !answer ||
        answer.status !== 404 ||
        typeof answer.body !== 'string' ||
        !answer.body.includes(marker)
      ) {
        breaks('cause', "the provider's answer (status and body) is not in the error");
      } else if (errorField(reason, 'kind') !== 'not_found') {
        breaks('cause', `a 404 came back as ${String(errorField(reason, 'kind'))}`);
      }
    }
  }

  // 5. lists.
  if (op.returns === 'list') {
    const fixture = adapter.listFixtures?.[op.slug];
    if (!fixture) {
      breaks('list', 'declared a list, but the table holds no three-page fixture for it');
      breaks('cut', 'declared a list, but the table holds no fixture for it');
    } else {
      await evaluateList(adapter, op, sample, fixture, breaks);
    }
  } else if (op.isList) {
    breaks('list', 'reads a provider collection, but is not declared returns: "list"');
    breaks('cut', 'reads a provider collection, but is not declared returns: "list"');
  }

  return { adapter: adapter.slug, operation: op.slug, broken, unusableSample: null };
}

interface ListResultShape {
  items: unknown[];
  next: string | null;
  truncated: { readMore?: unknown } | null;
  total?: unknown;
}

function asList(value: unknown): ListResultShape | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['items'])) return null;
  if (!(v['next'] === null || typeof v['next'] === 'string')) return null;
  if (!(v['truncated'] === null || typeof v['truncated'] === 'object')) return null;
  return v as unknown as ListResultShape;
}

async function evaluateList(
  adapter: ContractAdapter,
  op: ContractOperation,
  sample: unknown,
  fixture: ListFixture,
  breaks: (rule: ContractRule, detail: string) => void,
): Promise<void> {
  const read = async (big: boolean, maxCalls: number) => {
    const provider = answeringProvider((req) => fixture.answer(req, fixture.pages, big));
    const tool = toolOf(adapter, provider, SUITE_ANSWER_BOUND_MS, op.slug);
    const calls: ListResultShape[] = [];
    let cursor: string | null | undefined = undefined;
    for (let i = 0; i < maxCalls; i++) {
      const input = cursor ? { ...(sample as object), cursor } : sample;
      const out = await runCall(
        `${adapter.slug}/${op.slug}#list`,
        adapter.sampleContext?.(op.slug) ?? {},
        tool,
        input,
        new AbortController(),
        SUITE_ANSWER_BOUND_MS,
        'refuse',
      );
      if (out.settled.status !== 'fulfilled')
        return { calls, error: messageOf(out.settled.reason) };
      const list = asList(out.settled.value);
      if (!list) return { calls, error: 'the result is not { items, next, truncated }' };
      calls.push(list);
      cursor = list.next;
      if (!cursor) break;
    }
    return { calls, error: null };
  };

  const want = fixture.pages.flat();
  // Three pages, three calls.
  {
    const { calls, error } = await read(false, 6);
    if (error) breaks('list', error);
    else {
      const got = calls.flatMap((c) => c.items.map(fixture.idOf));
      if (calls.length !== 3 || JSON.stringify(got) !== JSON.stringify(want)) {
        breaks('list', `read ${got.length} of ${want.length} items in ${calls.length} call(s)`);
      }
      const last = calls[calls.length - 1];
      if (last && last.next !== null) breaks('list', 'the last page still offers a cursor');
      for (const c of calls) {
        if (c.total !== undefined && c.total !== want.length) {
          breaks('list', `"total" is ${String(c.total)}, the provider holds ${want.length}`);
        }
      }
    }
  }
  // Items too large for one result: the cut is stated and `next` reads on.
  {
    const { calls, error } = await read(true, 40);
    if (error) breaks('cut', error);
    else {
      const got = calls.flatMap((c) => c.items.map(fixture.idOf));
      const stated = calls.some(
        (c) => c.truncated !== null && typeof c.truncated.readMore === 'string',
      );
      if (!stated)
        breaks('cut', 'no result said it was cut, though the items exceed the result budget');
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        breaks('cut', `following "next" read ${got.length} of ${want.length} items`);
      }
    }
  }
}

// ── Comparing with the ratchet ──────────────────────────────────────────────

/**
 * What the measurement says against the ratchet, as one line per problem.
 * `frozenAdapters` are the adapters that existed when the ratchet was
 * written: no other may appear in it.
 */
export function compareToRatchet(
  results: readonly OperationResult[],
  ratchet: ContractRatchet,
  frozenAdapters: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const slug of Object.keys(ratchet)) {
    if (!frozenAdapters.includes(slug)) {
      problems.push(
        `${slug}: an adapter added after the ratchet was frozen cannot be listed in it; it must conform`,
      );
    }
  }
  const measured = new Set(results.map((r) => `${r.adapter}/${r.operation}`));
  for (const [slug, ops] of Object.entries(ratchet)) {
    for (const op of Object.keys(ops)) {
      if (!measured.has(`${slug}/${op}`))
        problems.push(`${slug}/${op}: listed in the ratchet, but no such operation is registered`);
    }
  }
  for (const r of results) {
    if (r.unusableSample) {
      problems.push(`${r.adapter}/${r.operation}: ${r.unusableSample}`);
      continue;
    }
    const listed = new Set(ratchet[r.adapter]?.[r.operation] ?? []);
    const broken = new Set(r.broken.map((b) => b.rule));
    for (const b of r.broken) {
      if (!listed.has(b.rule))
        problems.push(`${r.adapter}/${r.operation}: breaks "${b.rule}" (not listed): ${b.detail}`);
    }
    for (const rule of listed) {
      if (!broken.has(rule)) {
        problems.push(
          `${r.adapter}/${r.operation}: now conforms to "${rule}": remove it from the ratchet`,
        );
      }
    }
  }
  return problems;
}

/** Counts of broken rules, per rule and per adapter, for the report. */
export function contractReport(results: readonly OperationResult[]): {
  operations: number;
  conforming: number;
  perRule: Record<string, number>;
  perAdapter: Record<
    string,
    { operations: number; conforming: number; broken: Record<string, number> }
  >;
} {
  const perRule: Record<string, number> = {};
  const perAdapter: Record<
    string,
    { operations: number; conforming: number; broken: Record<string, number> }
  > = {};
  let conforming = 0;
  for (const r of results) {
    const a = (perAdapter[r.adapter] ??= { operations: 0, conforming: 0, broken: {} });
    a.operations += 1;
    if (r.broken.length === 0 && !r.unusableSample) {
      conforming += 1;
      a.conforming += 1;
    }
    for (const b of r.broken) {
      perRule[b.rule] = (perRule[b.rule] ?? 0) + 1;
      a.broken[b.rule] = (a.broken[b.rule] ?? 0) + 1;
    }
  }
  return { operations: results.length, conforming, perRule, perAdapter };
}

// ── The suite ───────────────────────────────────────────────────────────────

export interface ConnectorContractSuiteOptions {
  adapters: readonly ContractAdapter[];
  ratchet: ContractRatchet;
  frozenAdapters: readonly string[];
  /** Where to write the measurement (counts per rule and per adapter), for the PR. */
  report?: (report: ReturnType<typeof contractReport>, results: readonly OperationResult[]) => void;
}

/** Register the suite in the calling test file. */
export function runConnectorContractSuite(options: ConnectorContractSuiteOptions): void {
  describe('connector contract: every operation of every adapter', () => {
    const results: OperationResult[] = [];
    describe.concurrent('measure', () => {
      for (const adapter of options.adapters) {
        for (const op of adapter.operations) {
          it(`${adapter.slug}/${op.slug}`, async () => {
            results.push(await evaluateOperation(adapter, op));
          });
        }
      }
    });
    it('matches the ratchet, both ways', () => {
      const expected = options.adapters.reduce((n, a) => n + a.operations.length, 0);
      expect(results.length).toBe(expected);
      options.report?.(contractReport(results), results);
      expect(compareToRatchet(results, options.ratchet, options.frozenAdapters)).toEqual([]);
    });
  });
}

// ── Sample inputs, from the schema ──────────────────────────────────────────

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  format?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  default?: unknown;
};

function fromJsonSchema(s: JsonSchema): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum && s.enum.length > 0) return s.enum[0];
  const alt = s.anyOf ?? s.oneOf;
  if (alt && alt.length > 0) {
    const nonNull = alt.find((a) => a.type !== 'null') ?? alt[0]!;
    return fromJsonSchema(nonNull);
  }
  if (s.allOf && s.allOf.length > 0) return fromJsonSchema(s.allOf[0]!);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) out[key] = fromJsonSchema(s.properties?.[key] ?? {});
      return out;
    }
    case 'array':
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () =>
        fromJsonSchema(s.items ?? {}),
      );
    case 'string': {
      if (s.format === 'email') return 'someone@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/sample';
      if (s.format === 'date-time') return '2026-11-20T10:00:00Z';
      if (s.format === 'date') return '2026-11-20';
      return 'sample'.padEnd(Math.max(6, s.minLength ?? 0), 'x');
    }
    case 'integer':
    case 'number':
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case 'boolean':
      return false;
    default:
      return 'sample';
  }
}

/** A minimal input of `schema`: its required fields, each with a plain value. */
export function sampleFromSchema(schema: z.ZodTypeAny): unknown {
  return fromJsonSchema(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema,
  );
}
