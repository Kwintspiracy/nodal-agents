// connector-accounts.test.ts — several accounts of one service on one agent.
//
// An agent may hold two connectors of one service (a personal and a work
// mailbox, or one Airtable by its key and another by OAuth). Each lends the
// same tool names. Before this rule the job kept both sets, the model saw each
// name twice, and every call ran on whichever assignment the database returned
// last. Now the tool appears ONCE, with an `account` argument whose values are
// the accounts that lend it; each call runs with that account's credential; a
// call that names no account is refused with the list.
//
// The real path: executeJob, a real test database, the adapters of the
// registry. The model is a scripted mock that keeps every request it is sent
// (the tool definitions and the tool results it reads). Airtable's client goes
// through the global `fetch`, so the test reads the credential each call
// carries; Gmail's does not, so no Gmail tool is ever executed here (nothing
// leaves this machine).

// A connector test fakes its provider: reaching the network fails this file
// (packages/test-kit/src/no-network.ts).
import '@nodal-agents/test-kit/setup-no-network';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  and,
  eq,
  agentJobs,
  agents,
  approvalRequests,
  connectors,
  credentials,
  agentConnectorAssignments,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { getOAuthProvider } from '@nodal-agents/shared';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import { buildApprovalCardBody } from '../../approvals/notify.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { testEnv } from './tool-loading-harness.ts';

// ─── Module-level mock registry ───────────────────────────────────────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: unknown = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: unknown) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return { ...actual, sendTelegramMessage: vi.fn().mockResolvedValue({ messageId: 999 }) };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('connector-accounts.test: no active LLM client set');
      return active;
    },
  };
});

// ─── The scripted model ───────────────────────────────────────────────────────

type Call = { toolName: string; args: Record<string, unknown> };
type ModelTool = { name: string; description?: string; inputSchema: JsonSchema };
type JsonSchema = {
  properties?: Record<string, { enum?: string[]; description?: string }>;
  required?: string[];
};
type Request = { tools: ModelTool[]; prompt: string };

/** A model that plays `turns` (then answers in text) and keeps every request it receives. */
function scriptedModel(turns: Call[][]): { client: RunnerDeps['llmClient']; requests: Request[] } {
  const requests: Request[] = [];
  // Call ids unique across the runs of one job (a resume replays the history).
  const run = randomBytes(4).toString('hex');
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      requests.push({
        tools: (options.tools ?? []) as unknown as ModelTool[],
        // Read as text, escapes removed: `"account":"Work"` whatever the nesting.
        prompt: JSON.stringify(options.prompt).replace(/\\+/g, ''),
      });
      const calls = turns[requests.length - 1];
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      };
      if (!calls) {
        return {
          content: [{ type: 'text' as const, text: 'Done.' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      return {
        content: calls.map((c, i) => ({
          type: 'tool-call' as const,
          toolCallId: `tc-${run}-${requests.length}-${i}`,
          toolName: c.toolName,
          input: JSON.stringify(c.args),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });
  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
  return { client, requests };
}

const finish: Call = { toolName: 'return_result', args: { status: 'success' } };

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db
    .delete(agentConnectorAssignments)
    .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  await db.delete(connectors).where(eq(connectors.entityId, seed.entityId));
});

function makeDeps(client: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(client);
  return {
    db: db as RunnerDeps['db'],
    llmClient: client,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

type Account =
  | { kind: 'key'; slug: string; name: string; key: string; operations?: string[] | null }
  | {
      kind: 'oauth';
      slug: string;
      name: string;
      type: 'google-oauth' | 'airtable-oauth' | 'microsoft-oauth' | 'notion-oauth';
      token: string;
      address: string;
      operations?: string[] | null;
    };

/** Give the agent these connectors, assigned in this order. */
async function give(accounts: readonly Account[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const a of accounts) {
    let credentialId: string | null = null;
    if (a.kind === 'oauth') {
      const [cred] = await db
        .insert(credentials)
        .values({
          ownerUserId: seed.userId,
          name: `${a.name} credential`,
          type: a.type,
          payload: encrypt(
            JSON.stringify({
              accessToken: a.token,
              refreshToken: 'rt',
              expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
              clientId: 'cid',
              clientSecret: 'cs',
              scopes: getOAuthProvider(a.slug)!.scopes.join(' '),
              accountName: a.address,
              tokenUrl: 'https://example.invalid/token',
            }),
          ),
        })
        .returning();
      credentialId = cred!.id;
    }
    const [conn] = await db
      .insert(connectors)
      .values({
        entityId: seed.entityId,
        name: a.name,
        slug: a.slug,
        authType: a.kind === 'key' ? 'api_key' : 'oauth2',
        active: true,
        ...(a.kind === 'key' ? { apiKey: encrypt(a.key) } : { credentialId }),
      })
      .returning();
    ids.set(a.name, conn!.id);
    await db.insert(agentConnectorAssignments).values({
      agentId: seed.agentId,
      connectorId: conn!.id,
      entityId: seed.entityId,
      enabledOperations: a.operations ?? null,
    });
  }
  return ids;
}

/** Every Airtable request, with the credential it carries. */
function airtableNetwork(): Array<{ method: string; url: string; auth: string | null }> {
  const seen: Array<{ method: string; url: string; auth: string | null }> = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('api.airtable.com')) return realFetch(input, init);
    seen.push({
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return new Response(
      JSON.stringify({ bases: [{ id: 'app1', name: 'Base', permissionLevel: 'create' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return seen;
}

async function newJob(task = 'Work with my accounts'): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  return job!.id;
}

/** One job: the requests the model received, and the job's row. */
async function runJob(turns: Call[][], jobId?: string) {
  const id = jobId ?? (await newJob());
  const { client, requests } = scriptedModel(turns);
  const result = await executeJob(id as JobId, makeDeps(client), testEnv);
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, id));
  return { id, result, requests, row: row! };
}

/** The definitions of `name` the model received in `request` (normally one). */
function definitionsOf(request: Request, name: string): ModelTool[] {
  return request.tools.filter((t) => t.name === name);
}

function accountArgument(tool: ModelTool) {
  return {
    values: tool.inputSchema.properties?.['account']?.enum ?? null,
    required: tool.inputSchema.required?.includes('account') ?? false,
    description: tool.inputSchema.properties?.['account']?.description ?? '',
  };
}

const load = (...names: string[]): Call => ({ toolName: 'load_tools', args: { names } });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('several accounts of one service on one agent @cap:assigner-outils/moteur', () => {
  const twoGmail: Account[] = [
    {
      kind: 'oauth',
      slug: 'gmail',
      name: 'Personal',
      type: 'google-oauth',
      token: 'at-personal',
      address: 'me@personal.example',
    },
    {
      kind: 'oauth',
      slug: 'gmail',
      name: 'Work',
      type: 'google-oauth',
      token: 'at-work',
      address: 'me@work.example',
    },
  ];

  for (const order of ['as written', 'reversed'] as const) {
    it(`two Gmail accounts (assigned ${order}): each tool reaches the model once, with both accounts, and a call without one is refused with both names`, async () => {
      await give(order === 'as written' ? twoGmail : [...twoGmail].reverse());
      const { requests, row } = await runJob([
        [load('gmail_send_email', 'gmail_list_messages')],
        [
          {
            toolName: 'gmail_send_email',
            args: { to: 'boss@work.example', subject: 'Hi', body: 'Hello' },
          },
        ],
        [finish],
      ]);

      expect(row.status, String(row.error ?? '')).toBe('completed');
      // The index lists the name once.
      expect(requests[0]!.prompt.split('gmail_send_email').length - 1).toBe(1);
      const send = definitionsOf(requests[1]!, 'gmail_send_email');
      expect(send).toHaveLength(1);
      expect(accountArgument(send[0]!)).toMatchObject({
        values: ['Personal', 'Work'],
        required: true,
      });
      // What identifies each account at the provider is read with the value.
      expect(accountArgument(send[0]!).description).toContain('"Work" (me@work.example)');
      expect(accountArgument(send[0]!).description).toContain('"Personal" (me@personal.example)');
      expect(accountArgument(definitionsOf(requests[1]!, 'gmail_list_messages')[0]!)).toMatchObject(
        { values: ['Personal', 'Work'], required: true },
      );
      // No account: refused, both names given, nothing sent.
      const refusal = requests[2]!.prompt;
      expect(refusal).toContain('account_required');
      expect(refusal).toContain('"Personal" (me@personal.example)');
      expect(refusal).toContain('"Work" (me@work.example)');
      expect(refusal).toContain('This call did NOT run');
    }, 60_000);
  }

  for (const order of ['as written', 'reversed'] as const) {
    it(`two Airtable keys (assigned ${order}): each call runs with its own account's credential, and the result names the account`, async () => {
      const accounts: Account[] = [
        { kind: 'key', slug: 'airtable', name: 'Work', key: 'pat-work' },
        { kind: 'key', slug: 'airtable', name: 'Personal', key: 'pat-personal' },
      ];
      await give(order === 'as written' ? accounts : [...accounts].reverse());
      const network = airtableNetwork();
      const { id, requests, row } = await runJob([
        [{ toolName: 'airtable_list_bases', args: { account: 'Work' } }],
        [{ toolName: 'airtable_list_bases', args: { account: 'Personal' } }],
        [finish],
      ]);

      expect(row.status, String(row.error ?? '')).toBe('completed');
      expect(network.map((r) => r.auth)).toEqual(['Bearer pat-work', 'Bearer pat-personal']);
      // The model reads which account answered.
      expect(requests[1]!.prompt).toContain('"account":"Work"');
      expect(requests[2]!.prompt).toContain('"account":"Personal"');
      // The audit rows name it too.
      const rows = await db
        .select({ input: toolCalls.toolInput, output: toolCalls.toolOutput })
        .from(toolCalls)
        .where(and(eq(toolCalls.jobId, id), eq(toolCalls.toolName, 'airtable_list_bases')));
      expect(rows.map((r) => (r.input as { account: string }).account).sort()).toEqual([
        'Personal',
        'Work',
      ]);
      for (const r of rows) {
        const account = (r.input as { account: string }).account;
        expect(r.output).toContain(`"account":"${account}"`);
      }
    }, 60_000);
  }

  it('one account only: the tool is what it was, no account argument, and the call runs with its credential', async () => {
    await give([{ kind: 'key', slug: 'airtable', name: 'Only', key: 'pat-only' }]);
    const network = airtableNetwork();
    const { requests, row } = await runJob([
      [load('airtable_list_bases')],
      [{ toolName: 'airtable_list_bases', args: {} }],
      [finish],
    ]);

    expect(row.status, String(row.error ?? '')).toBe('completed');
    const list = definitionsOf(requests[1]!, 'airtable_list_bases');
    expect(list).toHaveLength(1);
    expect(list[0]!.inputSchema.properties?.['account']).toBeUndefined();
    expect(network.map((r) => r.auth)).toEqual(['Bearer pat-only']);
    expect(requests[2]!.prompt).not.toContain('"account":');
  }, 60_000);

  it('different operation lists: an operation allowed on one account is offered with that account only, and cannot reach the other', async () => {
    await give([
      {
        kind: 'key',
        slug: 'airtable',
        name: 'Reader',
        key: 'pat-reader',
        operations: ['airtable_list_bases'],
      },
      {
        kind: 'key',
        slug: 'airtable',
        name: 'Writer',
        key: 'pat-writer',
        operations: ['airtable_list_bases', 'airtable_list_records'],
      },
    ]);
    const network = airtableNetwork();
    const { requests, row } = await runJob([
      [load('airtable_list_bases', 'airtable_list_records')],
      [
        {
          toolName: 'airtable_list_records',
          args: { account: 'Reader', baseId: 'app1', tableIdOrName: 'T' },
        },
      ],
      [finish],
    ]);

    expect(row.status, String(row.error ?? '')).toBe('completed');
    expect(accountArgument(definitionsOf(requests[1]!, 'airtable_list_bases')[0]!).values).toEqual([
      'Reader',
      'Writer',
    ]);
    expect(accountArgument(definitionsOf(requests[1]!, 'airtable_list_records')[0]!)).toMatchObject(
      { values: ['Writer'], required: true },
    );
    // Refused before any request: the Reader's key never carried that operation.
    expect(requests[2]!.prompt).toContain('"Reader" is not one of the accounts');
    expect(network).toEqual([]);
  }, 60_000);

  it('the two forms of one service (an Airtable key and an Airtable OAuth app): one tool, both accounts, each with its own credential', async () => {
    await give([
      { kind: 'key', slug: 'airtable', name: 'Team base', key: 'pat-team' },
      {
        kind: 'oauth',
        slug: 'airtable-oauth',
        name: 'My base',
        type: 'airtable-oauth',
        token: 'oauth-mine',
        address: 'me@example.com',
      },
    ]);
    const network = airtableNetwork();
    const { requests, row } = await runJob([
      [load('airtable_list_bases')],
      [{ toolName: 'airtable_list_bases', args: { account: 'My base' } }],
      [{ toolName: 'airtable_list_bases', args: { account: 'Team base' } }],
      [finish],
    ]);

    expect(row.status, String(row.error ?? '')).toBe('completed');
    const list = definitionsOf(requests[1]!, 'airtable_list_bases');
    expect(list).toHaveLength(1);
    expect(accountArgument(list[0]!).values).toEqual(['My base', 'Team base']);
    expect(network.map((r) => r.auth)).toEqual(['Bearer oauth-mine', 'Bearer pat-team']);
  }, 60_000);

  it('another provider (Outlook, two Microsoft accounts): the same rule, once and with both accounts', async () => {
    await give([
      {
        kind: 'oauth',
        slug: 'outlook-mail',
        name: 'Office',
        type: 'microsoft-oauth',
        token: 'ms-office',
        address: 'me@office.example',
      },
      {
        kind: 'oauth',
        slug: 'outlook-mail',
        name: 'Home',
        type: 'microsoft-oauth',
        token: 'ms-home',
        address: 'me@home.example',
      },
    ]);
    const { requests, row } = await runJob([[load('outlook_send_email')], [finish]]);

    expect(row.status, String(row.error ?? '')).toBe('completed');
    const send = definitionsOf(requests[1]!, 'outlook_send_email');
    expect(send).toHaveLength(1);
    expect(accountArgument(send[0]!)).toMatchObject({ values: ['Home', 'Office'], required: true });
  }, 60_000);

  it('two accounts of one service under names a model could not tell apart: the job is refused, naming both', async () => {
    await give([
      { kind: 'key', slug: 'notion', name: 'Notion', key: 'secret-a' },
      {
        kind: 'oauth',
        slug: 'notion-oauth',
        name: ' notion ',
        type: 'notion-oauth',
        token: 'n-b',
        address: 'Workspace',
      },
    ]);
    const { requests, row } = await runJob([[finish]]);

    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('"Notion" (notion)');
    expect(String(row.error)).toContain('" notion " (notion-oauth)');
    expect(String(row.error)).toContain('Rename one of them');
    expect(requests).toHaveLength(0);
  }, 60_000);
});

describe('a held call on one of several accounts @cap:approuver-une-action/moteur', () => {
  const accounts: Account[] = [
    { kind: 'key', slug: 'airtable', name: 'Work', key: 'pat-work' },
    { kind: 'key', slug: 'airtable', name: 'Personal', key: 'pat-personal' },
  ];
  const deleteOnWork: Call = {
    toolName: 'airtable_delete_record',
    args: {
      account: 'Work',
      baseId: 'appBASE',
      tableIdOrName: 'Contacts',
      recordId: 'recTARGET',
      purpose: 'Remove the duplicate contact.',
    },
  };

  async function approveAndResume(jobId: string): Promise<void> {
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.jobId, jobId));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId));
  }

  it('the card and the request name the account; approved, the call runs on that account', async () => {
    await give(accounts);
    const network = airtableNetwork();
    const first = await runJob([[deleteOnWork], [finish]]);
    expect(first.result.status).toBe('awaiting_approval');

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, first.id));
    expect(pending!.toolInput).toMatchObject({ account: 'Work', recordId: 'recTARGET' });
    const card = await buildApprovalCardBody(db as RunnerDeps['db'], {
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: pending!.toolName,
      toolInput: pending!.toolInput,
      who: 'Agent',
    });
    expect(card).toContain('Work');
    expect(network).toEqual([]);

    await approveAndResume(first.id);
    const resumed = await runJob([[finish]], first.id);
    expect(resumed.row.status, String(resumed.row.error ?? '')).toBe('completed');
    expect(network).toEqual([
      {
        method: 'DELETE',
        url: 'https://api.airtable.com/v0/appBASE/Contacts/recTARGET',
        auth: 'Bearer pat-work',
      },
    ]);
  }, 90_000);

  it('resumed after the account was renamed: the list is rebuilt, the stale name is refused with the current accounts, nothing runs', async () => {
    const ids = await give(accounts);
    const network = airtableNetwork();
    const first = await runJob([[deleteOnWork], [finish]]);
    expect(first.result.status).toBe('awaiting_approval');

    await db
      .update(connectors)
      .set({ name: 'Office' })
      .where(eq(connectors.id, ids.get('Work')!));
    await approveAndResume(first.id);
    const resumed = await runJob([[finish]], first.id);

    expect(network).toEqual([]);
    const rows = await db
      .select({ output: toolCalls.toolOutput })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, first.id), eq(toolCalls.toolName, 'airtable_delete_record')));
    const said = [...rows.map((r) => r.output ?? ''), ...resumed.requests.map((r) => r.prompt)]
      .join('\n')
      .replace(/\\+/g, '');
    expect(said).toContain('"Work" is not one of the accounts');
    expect(said).toContain('"Office"');
    expect(said).toContain('"Personal"');
  }, 90_000);
});
