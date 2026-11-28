// connector-contract-proofs.test.ts — the connector contract, proved on named
// adapters of four providers (Google Drive, Microsoft Graph, Notion,
// Airtable), and its shared layer proved on an adapter this change never
// touched (Tavily). The table-driven suite (connector-contract.test.ts)
// measures every operation; these cases state each promise once, with the
// request the provider received and what the tool returned or threw.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withNetworkScope } from '@nodal-agents/test-kit/no-network';
import {
  compareToRatchet,
  evaluateOperation,
  type ContractAdapter,
  type ContractTool,
} from '@nodal-agents/test-kit/connector-contract-suite';
import { ConnectorCallError, TOOL_RESULT_MODEL_CHARS } from '@nodal-agents/shared';
import type { ToolContext, ToolDefinition } from '@nodal-agents/tools';
import { ADAPTER_REGISTRY } from '../registry';
import {
  DEFAULT_CALL_BOUND_MS,
  holdToContract,
  idempotencyKeyFor,
} from '../connector-contract-layer';
import { CONTRACT_PROVIDERS } from './contract-providers';
import { CONTRACT_LIST_FIXTURES } from './contract-lists';
import { CONTRACT_RATCHET, RATCHET_FROZEN_ADAPTERS } from './contract-ratchet';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

function ctx(signal?: AbortSignal, over: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: 'job-proof',
    agentId: 'agent-proof',
    entityId: 'entity-proof',
    db: null as never,
    jobChatId: null,
    toolCallId: 'call-proof-1',
    ...(signal ? { signal } : {}),
    ...over,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Seen {
  method: string;
  url: string;
  body: string;
  abortedAt: number | null;
}

/** A provider that answers safe requests with `{}` and never answers a write. */
function writeHangs(): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const entry: Seen = {
      method: req.method,
      url: req.url,
      body: await req.text(),
      abortedAt: null,
    };
    seen.push(entry);
    if (req.method === 'GET') return json(200, {});
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          entry.abortedAt = Date.now();
          reject(init.signal!.reason);
        },
        { once: true },
      );
    });
  }) as typeof fetch;
  return { fetch: fake, seen };
}

/** A provider that answers every request with `answer()`. */
function answering(answer: (req: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    seen.push({
      method: req.method,
      url: req.url,
      body: await req.clone().text(),
      abortedAt: null,
    });
    return answer(req);
  }) as typeof fetch;
  return { fetch: fake, seen };
}

function toolOf(slug: string, op: string, io: { fetch: typeof fetch; boundMs?: number }): AnyTool {
  const tool = ADAPTER_REGISTRY[slug]!.toolFactory('proof-token', io).find((t) => t.name === op);
  if (!tool) throw new Error(`no tool ${op}`);
  return tool;
}

async function failure(p: Promise<unknown>): Promise<ConnectorCallError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorCallError);
    return err as ConnectorCallError;
  }
  throw new Error('the call succeeded');
}

// ── 1. A list of three pages is read in three calls ─────────────────────────

describe('connector contract: a provider list of three pages reads in three calls @cap:connecter-un-service/moteur', () => {
  const cases: Array<
    [slug: string, op: string, input: Record<string, unknown>, cursorOf: (s: Seen) => string | null]
  > = [
    ['google-drive', 'drive_list_files', {}, (s) => new URL(s.url).searchParams.get('pageToken')],
    ['outlook-mail', 'outlook_list_messages', {}, (s) => new URL(s.url).searchParams.get('$skip')],
    [
      'notion',
      'notion_query_database',
      { database_id: 'db-1' },
      (s) => (JSON.parse(s.body || '{}') as { start_cursor?: string }).start_cursor ?? null,
    ],
    [
      'airtable',
      'airtable_list_records',
      { baseId: 'app1', tableIdOrName: 'Tasks' },
      (s) => new URL(s.url).searchParams.get('offset'),
    ],
  ];
  for (const [slug, op, input, cursorOf] of cases) {
    it(`${slug}/${op}`, async () => {
      const fixture = CONTRACT_LIST_FIXTURES[slug]![op]!;
      const provider = answering((req) => fixture.answer(req, fixture.pages, false));
      const tool = toolOf(slug, op, { fetch: provider.fetch });
      const pages: unknown[][] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 3; i++) {
        const out = (await tool.execute(
          tool.inputSchema.parse(cursor ? { ...input, cursor } : input),
          ctx(),
        )) as { items: unknown[]; next: string | null; truncated: unknown };
        expect(out.truncated).toBeNull();
        pages.push(out.items);
        cursor = out.next;
      }
      expect(cursor).toBeNull();
      expect(pages.map((p) => p.map(fixture.idOf))).toEqual(fixture.pages);
      // What the provider received: no cursor, then its own cursor of page 2, then of page 3.
      expect(provider.seen.map((s) => cursorOf(s) !== null)).toEqual([false, true, true]);
      expect(new Set(provider.seen.map(cursorOf)).size).toBe(3);
    });
  }
});

// ── 2. A pace refusal is rate_limited, whatever status the provider used ────

describe('connector contract: a pace refusal is rate_limited, with its time @cap:connecter-un-service/moteur', () => {
  it('Google answers 403 rateLimitExceeded: rate_limited, no time invented, the cause kept', async () => {
    const google = CONTRACT_PROVIDERS['google-drive']!.rateLimit.find((f) =>
      f.label.startsWith('403'),
    )!;
    const tool = toolOf('google-drive', 'drive_get_file_info', {
      fetch: answering(() => google.answer()).fetch,
    });
    const err = await failure(tool.execute({ file_id: 'f1' }, ctx()));
    expect(err.kind).toBe('rate_limited');
    expect(err.status).toBe(403);
    expect(err.providerCode).toBe('rateLimitExceeded');
    expect(err.retryAfter).toBeNull();
    expect(err.message).toMatch(/^rate_limited: /);
    expect(err.message).toContain('The provider gave no time to try again.');
    // Before the contract this was the adapter's `drive_forbidden`, read as "no permission".
    expect((err.cause as { code?: string }).code).toBe('drive_forbidden');
  });

  for (const [slug, op, input] of [
    ['outlook-mail', 'outlook_get_message', { message_id: 'm1' }],
    ['notion', 'notion_get_page', { page_id: 'p1' }],
  ] as const) {
    it(`${slug} answers 429 with Retry-After: rate_limited, with the provider's time`, async () => {
      const form = CONTRACT_PROVIDERS[slug]!.rateLimit[0]!;
      const before = Date.now();
      const tool = toolOf(slug, op, { fetch: answering(() => form.answer()).fetch });
      const err = await failure(tool.execute(input, ctx()));
      expect(err.kind).toBe('rate_limited');
      expect(err.status).toBe(429);
      expect(err.retryAfter!.getTime()).toBeGreaterThanOrEqual(before + 119_000);
      expect(err.retryAfter!.getTime()).toBeLessThanOrEqual(Date.now() + 121_000);
      expect(err.message).toContain(`try again after ${err.retryAfter!.toISOString()}`);
    });
  }
});

// ── 3. The job's stop aborts the request within a second ────────────────────

describe("connector contract: the job's stop aborts the provider request within a second @cap:connecter-un-service/moteur", () => {
  for (const [slug, op, input] of [
    ['google-drive', 'drive_create_folder', { name: 'Reports' }],
    ['outlook-mail', 'outlook_send_email', { to: 'someone@example.com', subject: 'S', body: 'B' }],
    ['notion', 'notion_create_page', { parent_page_id: 'p1', title: 'T' }],
    [
      'airtable',
      'airtable_create_records',
      { baseId: 'app1', tableIdOrName: 'Tasks', records: [{ fields: { Name: 'x' } }] },
    ],
  ] as const) {
    it(`${slug}/${op}`, async () => {
      const provider = writeHangs();
      const tool = toolOf(slug, op, { fetch: provider.fetch });
      const job = new AbortController();
      const call = failure(tool.execute(tool.inputSchema.parse(input), ctx(job.signal)));
      await expect.poll(() => provider.seen.some((s) => s.method !== 'GET')).toBe(true);
      const stoppedAt = Date.now();
      job.abort(new Error('stopped by the person'));
      const err = await call;
      const write = provider.seen.find((s) => s.method !== 'GET')!;
      expect(write.abortedAt).not.toBeNull();
      expect(write.abortedAt! - stoppedAt).toBeLessThan(1_000);
      expect(Date.now() - stoppedAt).toBeLessThan(1_000);
      expect(err.kind).toBe('stopped');
      // The write had left: its outcome is unknown, and the seam's flag says so.
      expect(err.mayHaveDelivered).toBe(true);
    });
  }
});

// ── 4. A write whose answer never came says its outcome is unknown ──────────

describe('connector contract: a write that timed out says its outcome is unknown @cap:connecter-un-service/moteur', () => {
  for (const [slug, op, input] of [
    ['outlook-mail', 'outlook_send_email', { to: 'someone@example.com', subject: 'S', body: 'B' }],
    ['google-drive', 'drive_create_folder', { name: 'Reports' }],
    ['notion', 'notion_create_page', { parent_page_id: 'p1', title: 'T' }],
    [
      'airtable',
      'airtable_create_records',
      { baseId: 'app1', tableIdOrName: 'Tasks', records: [{ fields: { Name: 'x' } }] },
    ],
  ] as const) {
    it(`${slug}/${op}: temporary, the bound named, mayHaveDelivered`, async () => {
      const provider = writeHangs();
      const tool = toolOf(slug, op, { fetch: provider.fetch, boundMs: 200 });
      const err = await failure(tool.execute(tool.inputSchema.parse(input), ctx()));
      expect(err.kind).toBe('temporary');
      expect(err.boundMs).toBe(200);
      expect(err.message).toContain("No answer came within the call's bound of 200 ms.");
      // `executeTool` reads exactly this property (packages/tools/src/execute.ts).
      expect((err as { mayHaveDelivered?: unknown }).mayHaveDelivered).toBe(true);
      expect(provider.seen.some((s) => s.method !== 'GET' && s.abortedAt !== null)).toBe(true);
    });
  }

  it('a read that timed out is a plain temporary failure (nothing to deliver)', async () => {
    const provider = answering(() => new Promise<Response>(() => undefined));
    const tool = toolOf('google-drive', 'drive_get_file_info', {
      fetch: provider.fetch,
      boundMs: 200,
    });
    const err = await failure(tool.execute({ file_id: 'f1' }, ctx()));
    expect(err.kind).toBe('temporary');
    expect(err.mayHaveDelivered).toBeUndefined();
  });

  it('a write cut before its request left is not called unknown, and no request leaves after the cut', async () => {
    // Notion's update reads the page first, and goes on to its write when
    // that read fails: after the cut, the transport sends nothing more.
    const provider = answering(
      (req) =>
        new Promise<Response>((_, reject) =>
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
        ),
    );
    const tool = toolOf('notion', 'notion_update_page', { fetch: provider.fetch, boundMs: 200 });
    const err = await failure(tool.execute({ page_id: 'p1', properties: { Name: 'x' } }, ctx()));
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.seen.map((s) => s.method)).toEqual(['GET']);
    expect(err.mayHaveDelivered).toBeUndefined();
  });
});

// ── 5. A cut is stated, and next reads the rest ─────────────────────────────

describe('connector contract: a page too large for the result is cut on whole items, said, and resumed @cap:connecter-un-service/moteur', () => {
  it('drive_list_files', async () => {
    const fixture = CONTRACT_LIST_FIXTURES['google-drive']!['drive_list_files']!;
    const provider = answering((req) => fixture.answer(req, fixture.pages, true));
    const tool = toolOf('google-drive', 'drive_list_files', { fetch: provider.fetch });
    const first = (await tool.execute({}, ctx())) as {
      items: Array<{ id: string }>;
      next: string;
      truncated: { reason: string; shown: number; of: number; readMore: string };
    };
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(first.items.map((i) => i.id)).toEqual(['item-a1', 'item-a2']);
    expect(first.truncated).toMatchObject({ reason: 'result_budget', shown: 2, of: 3 });
    expect(first.truncated.readMore).toContain('`cursor`');
    const second = (await tool.execute({ cursor: first.next }, ctx())) as {
      items: Array<{ id: string }>;
      next: string | null;
      truncated: unknown;
    };
    expect(second.items.map((i) => i.id)).toEqual(['item-a3']);
    expect(second.truncated).toBeNull();
    // The resume re-read page 1 (no pageToken) and hands on Drive's own cursor of page 2.
    expect(new URL(provider.seen[1]!.url).searchParams.get('pageToken')).toBeNull();
    expect(second.next).toBe('p2');
  });

  it('a cursor that is not one this tool returned is invalid input', async () => {
    const tool = toolOf('google-drive', 'drive_list_files', {
      fetch: answering(() => json(200, {})).fetch,
    });
    const err = await failure(tool.execute({ cursor: 'nodal-resume:@@@' }, ctx()));
    expect(err.kind).toBe('invalid_input');
  });
});

// ── 6. The provider's cause is kept ─────────────────────────────────────────

describe("connector contract: the provider's answer is in the error, untouched @cap:connecter-un-service/moteur", () => {
  it('a 404 of Graph: not_found, the body and the adapter error both kept', async () => {
    const graph = CONTRACT_PROVIDERS['outlook-mail']!;
    const tool = toolOf('outlook-mail', 'outlook_get_message', {
      fetch: answering(() => graph.error(404, 'marker-404-graph')).fetch,
    });
    const err = await failure(tool.execute({ message_id: 'm1' }, ctx()));
    expect(err.kind).toBe('not_found');
    expect(err.providerAnswer?.status).toBe(404);
    expect(err.providerAnswer?.body).toContain('marker-404-graph');
    expect(err.providerAnswer?.headers['content-type']).toBe('application/json');
    expect((err.cause as Error).name).toBe('OutlookAdapterError');
  });
});

// ── 7. The shared layer, on an adapter this change never touched ────────────

describe('connector contract: the shared layer holds for an adapter left as it was (Tavily) @cap:connecter-un-service/moteur', () => {
  const tavily = (boundMs?: number) =>
    toolOf('tavily', 'tavily_search', { fetch, ...(boundMs ? { boundMs } : {}) });

  it("the job's stop ends the call within a second", async () => {
    const { outcome } = await withNetworkScope(
      'tavily-stop',
      async () => {
        const job = new AbortController();
        const call = tavily().execute({ query: 'q' }, ctx(job.signal));
        setTimeout(() => job.abort(new Error('stop')), 100);
        const started = Date.now();
        const err = await failure(call);
        return { err, ms: Date.now() - started };
      },
      'hold',
    );
    expect(outcome.status).toBe('fulfilled');
    const { err, ms } = (outcome as PromiseFulfilledResult<{ err: ConnectorCallError; ms: number }>)
      .value;
    expect(err.kind).toBe('stopped');
    expect(ms).toBeLessThan(1_100);
  });

  it('the bound ends a call whose provider never answers, naming it', async () => {
    const { outcome } = await withNetworkScope(
      'tavily-bound',
      () => failure(tavily(300).execute({ query: 'q' }, ctx())),
      'hold',
    );
    const err = (outcome as PromiseFulfilledResult<ConnectorCallError>).value;
    expect(err.kind).toBe('temporary');
    expect(err.message).toContain('bound of 300 ms');
  });

  it("the adapter's own error is kept as the cause", async () => {
    const { outcome } = await withNetworkScope('tavily-cause', () =>
      failure(tavily().execute({ query: 'q' }, ctx())),
    );
    const err = (outcome as PromiseFulfilledResult<ConnectorCallError>).value;
    expect((err.cause as Error).name).toBe('TavilyApiError');
    expect(err.message).toContain((err.cause as Error).message);
  });
});

// ── 8. The ratchet only shrinks ─────────────────────────────────────────────

function fakeAdapter(slug: string, execute: AnyTool['execute']): ContractAdapter {
  const tool: ContractTool = {
    name: `${slug}_op`,
    inputSchema: z.object({}),
    execute: execute as ContractTool['execute'],
  };
  return {
    slug,
    operations: [{ slug: `${slug}_op`, risk: 'read' }],
    build: () => [tool],
    provider: CONTRACT_PROVIDERS['tavily']!,
    sampleInput: () => ({}),
  };
}

describe('connector contract: the ratchet can only shrink @cap:connecter-un-service/moteur', () => {
  it('a listed operation that starts conforming turns the comparison red until it is removed', async () => {
    const entry = ADAPTER_REGISTRY['google-drive']!;
    const adapter: ContractAdapter = {
      slug: 'google-drive',
      operations: [{ slug: 'drive_get_file_info', risk: 'read' }],
      build: (io) => entry.toolFactory('t', io) as unknown as ContractTool[],
      provider: CONTRACT_PROVIDERS['google-drive']!,
      sampleInput: () => ({ file_id: 'f1' }),
    };
    const result = await evaluateOperation(adapter, adapter.operations[0]!);
    expect(result.broken).toEqual([]);
    const ratchet = { 'google-drive': { drive_get_file_info: ['transport' as const] } };
    expect(compareToRatchet([result], ratchet, RATCHET_FROZEN_ADAPTERS)).toEqual([
      'google-drive/drive_get_file_info: now conforms to "transport": remove it from the ratchet',
    ]);
  });

  it('an unlisted operation broken on purpose turns it red', async () => {
    // Drive's tools built over the process's fetch instead of the one the suite gives:
    // the requests reach the network guard, as an adapter that drops the transport would.
    const entry = ADAPTER_REGISTRY['google-drive']!;
    const adapter: ContractAdapter = {
      slug: 'google-drive',
      operations: [{ slug: 'drive_get_file_info', risk: 'read' }],
      build: (io) => entry.toolFactory('t', { boundMs: io.boundMs }) as unknown as ContractTool[],
      provider: CONTRACT_PROVIDERS['google-drive']!,
      sampleInput: () => ({ file_id: 'f1' }),
    };
    const result = await evaluateOperation(adapter, adapter.operations[0]!);
    const problems = compareToRatchet([result], CONTRACT_RATCHET, RATCHET_FROZEN_ADAPTERS);
    expect(
      problems.some((p) =>
        p.startsWith('google-drive/drive_get_file_info: breaks "transport" (not listed)'),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.includes('breaks "rate_limited" (not listed)'))).toBe(true);
  });

  it('a new adapter that does not conform cannot be added to the ratchet', async () => {
    const hangs = fakeAdapter('fake-new', () => new Promise(() => undefined));
    const result = await evaluateOperation(hangs, hangs.operations[0]!);
    expect(result.unusableSample).not.toBeNull();
    const ratchet = { 'fake-new': { 'fake-new_op': ['transport' as const] } };
    expect(compareToRatchet([result], ratchet, RATCHET_FROZEN_ADAPTERS)).toContain(
      'fake-new: an adapter added after the ratchet was frozen cannot be listed in it; it must conform',
    );
  });

  it('every adapter of the registry was in it when the ratchet was frozen, and no other', () => {
    expect([...RATCHET_FROZEN_ADAPTERS].sort()).toEqual(Object.keys(ADAPTER_REGISTRY).sort());
  });
});

// ── 9. Registration ─────────────────────────────────────────────────────────

describe('connector contract: what the registry refuses and what it derives @cap:connecter-un-service/moteur', () => {
  const plain: AnyTool = {
    name: 'x_list',
    description: 'x',
    inputSchema: z.object({}),
    riskLevel: 'read',
    execute: async () => ({ items: [], next: null, truncated: null }),
  };

  it('an operation declared a list whose input takes no cursor cannot be registered', () => {
    expect(() =>
      holdToContract(
        plain,
        { slug: 'x_list', name: 'X', risk: 'read', requiresApproval: false, returns: 'list' },
        { passesTransport: true },
        {},
      ),
    ).toThrow(/declared a list.*no `cursor`/);
  });

  it('a list that returns another shape fails loud', async () => {
    const tool = holdToContract(
      {
        ...plain,
        inputSchema: z.object({ cursor: z.string().optional() }),
        execute: async () => ({ rows: [] }),
      },
      { slug: 'x_list', name: 'X', risk: 'read', requiresApproval: false, returns: 'list' },
      { passesTransport: true },
      {},
    );
    await expect(tool.execute({}, ctx())).rejects.toThrow(
      /declared a list and returned another shape/,
    );
  });

  it('a write receives an idempotency key derived from its tool-call id; a read none', async () => {
    const seen: Array<string | undefined> = [];
    const capture: AnyTool = {
      ...plain,
      execute: async (_input, c: ToolContext) => {
        seen.push(c.idempotencyKey);
        return {};
      },
    };
    const write = holdToContract(
      capture,
      { slug: 'x_write', name: 'X', risk: 'write', requiresApproval: false },
      { passesTransport: true },
      {},
    );
    const read = holdToContract(
      capture,
      { slug: 'x_read', name: 'X', risk: 'read', requiresApproval: false },
      { passesTransport: true },
      {},
    );
    await write.execute({}, ctx(undefined, { toolCallId: 'call-A' }));
    await write.execute({}, ctx(undefined, { toolCallId: 'call-A' }));
    await write.execute({}, ctx(undefined, { toolCallId: 'call-B' }));
    await read.execute({}, ctx(undefined, { toolCallId: 'call-A' }));
    expect(seen[0]).toBe(idempotencyKeyFor('call-A', 'x_write'));
    expect(seen[0]).toMatch(/^[0-9a-v]{32}$/);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[3]).toBeUndefined();
  });

  it('Calendar names its new event with that key, the client-chosen id its API documents', async () => {
    const provider = answering(() => json(200, { id: 'e1', htmlLink: 'h', summary: 's' }));
    const tool = toolOf('google-calendar', 'gcal_create_event', { fetch: provider.fetch });
    await tool.execute(
      tool.inputSchema.parse({
        summary: 's',
        start: '2026-11-20T10:00:00Z',
        end: '2026-11-20T11:00:00Z',
      }),
      ctx(undefined, { toolCallId: 'call-cal' }),
    );
    const sent = JSON.parse(provider.seen[0]!.body) as { id?: string };
    expect(sent.id).toBe(idempotencyKeyFor('call-cal', 'gcal_create_event'));
  });

  it('an operation without a declared bound gets the default one', () => {
    expect(DEFAULT_CALL_BOUND_MS).toBe(120_000);
    const long = ADAPTER_REGISTRY['apify']!.operations.find((o) => o.slug === 'apify_run_actor')!;
    expect(long.timeBoundMs).toBeGreaterThan(3_600_000);
  });
});
