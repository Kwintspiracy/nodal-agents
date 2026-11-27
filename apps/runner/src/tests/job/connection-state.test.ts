// connection-state.test.ts — a connection's state, written where it is learnt,
// read by the job: the tool's error and the next job's context say the same
// thing, and a grant the provider ended is not asked again.
//
// The real path: executeJob, a real test database, the adapters of the
// registry. The model is a scripted mock that keeps every request it is sent.
// Providers are faked at the transport each SDK uses: Airtable's client and
// every token endpoint go through the global `fetch`. Nothing leaves this
// machine: a request to any other host fails the test.

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
  eq,
  agentJobs,
  agents,
  connectors,
  credentials,
  connectionStates,
  agentConnectorAssignments,
  agentMcpServers,
  mcpServers,
  readConnectionState,
  recordConnectionState,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { getOAuthProvider } from '@nodal-agents/shared';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { testEnv } from './tool-loading-harness.ts';

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
      if (!active) throw new Error('connection-state.test: no active LLM client set');
      return active;
    },
  };
});

// ─── The scripted model ───────────────────────────────────────────────────────

type Call = { toolName: string; args: Record<string, unknown> };
type Request = { tools: string[]; prompt: string; at: number };

function scriptedModel(turns: Call[][]): { client: RunnerDeps['llmClient']; requests: Request[] } {
  const requests: Request[] = [];
  const run = randomBytes(4).toString('hex');
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      requests.push({
        tools: ((options.tools ?? []) as unknown as { name: string }[]).map((t) => t.name),
        prompt: JSON.stringify(options.prompt).replace(/\\+/g, ''),
        at: performance.now(),
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
  await db.delete(agentMcpServers);
  await db.delete(mcpServers);
  await db.delete(connectionStates);
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

async function oauthCredential(opts: {
  type: 'google-oauth' | 'airtable-oauth';
  scopes: string;
  expired?: boolean;
  address?: string;
}): Promise<string> {
  const [cred] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: `cred-${randomBytes(3).toString('hex')}`,
      type: opts.type,
      payload: encrypt(
        JSON.stringify({
          accessToken: 'at-stored',
          refreshToken: 'rt-stored',
          expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3600_000)).toISOString(),
          clientId: 'cid',
          clientSecret: 'cs',
          scopes: opts.scopes,
          accountName: opts.address ?? 'owner@example.test',
        }),
      ),
    })
    .returning();
  return cred!.id;
}

async function attach(c: {
  slug: string;
  name: string;
  credentialId?: string | null;
  apiKey?: string;
}): Promise<string> {
  const [conn] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: c.name,
      slug: c.slug,
      authType: c.apiKey !== undefined ? 'api_key' : 'oauth2',
      active: true,
      ...(c.apiKey !== undefined
        ? { apiKey: encrypt(c.apiKey) }
        : { credentialId: c.credentialId ?? null }),
    })
    .returning();
  await db.insert(agentConnectorAssignments).values({
    agentId: seed.agentId,
    connectorId: conn!.id,
    entityId: seed.entityId,
    enabledOperations: null,
  });
  return conn!.id;
}

type Seen = { url: string; at: number };

/**
 * The network as the job sees it: every request is recorded; `answer` decides
 * each, and a host it does not know fails the test (nothing leaves the machine).
 */
function network(answer: (url: string) => Promise<Response> | Response): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, at: performance.now() });
    return answer(url);
  });
  return seen;
}

const AIRTABLE_TOKEN_URL = getOAuthProvider('airtable-oauth')!.tokenUrl;
const GOOGLE_TOKEN_URL = getOAuthProvider('gmail')!.tokenUrl;
const airtableScopes = getOAuthProvider('airtable-oauth')!.scopes.join(' ');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function refused(): never {
  throw new Error('unexpected request');
}

async function newJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Do what I asked',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  return job!.id;
}

async function runJob(turns: Call[][]) {
  const id = await newJob();
  const { client, requests } = scriptedModel(turns);
  const claimedAt = performance.now();
  const result = await executeJob(id as JobId, makeDeps(client), testEnv);
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, id));
  return { id, result, requests, row: row!, claimedAt };
}

const DISCONNECTED = 'is attached but disconnected';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('a grant the provider ended @cap:connecter-un-service/moteur', () => {
  it('marks the credential needs_reauth; the tool error, the next context and the stored row say it; the next job asks the token endpoint nothing', async () => {
    const credentialId = await oauthCredential({
      type: 'airtable-oauth',
      scopes: airtableScopes,
      expired: true,
      address: 'me@base.example',
    });
    await attach({ slug: 'airtable-oauth', name: 'My base', credentialId });

    // Job 1: the call needs a fresh token; the token endpoint says the grant ended.
    const first = network((url) =>
      url === AIRTABLE_TOKEN_URL
        ? json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400)
        : refused(),
    );
    const job1 = await runJob([[{ toolName: 'airtable_list_bases', args: {} }], [finish]]);
    expect(first.map((s) => s.url)).toEqual([AIRTABLE_TOKEN_URL]);
    // The tool's error, as the model reads it.
    const toolError = job1.requests[1]!.prompt;
    expect(toolError).toContain('connection_needs_reauth: grant_refused');
    expect(toolError).toContain(`My base (account "me@base.example") ${DISCONNECTED}`);
    expect(toolError).toContain('the Connectors page (Reconnect)');
    // The stored row.
    expect(await readConnectionState(db, { kind: 'credential', id: credentialId })).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
      detail: '400 invalid_grant Refresh token expired',
    });

    // Job 2: its context names the account as disconnected, its list holds no
    // Airtable tool, and the token endpoint is not asked again.
    const second = network(() => refused());
    const job2 = await runJob([[finish]]);
    expect(second).toEqual([]);
    const context = job2.requests[0]!.prompt;
    expect(context).toContain('Attached to you but not usable in this job');
    expect(context).toContain(`My base (account "me@base.example") ${DISCONNECTED}`);
    expect(context).toContain('the provider refused its authorisation');
    expect(job2.requests[0]!.tools.filter((t) => t.startsWith('airtable_'))).toEqual([]);
  }, 60_000);

  it('the same for a key the provider refuses (a second provider, an API key): the connector itself is needs_reauth', async () => {
    const connectorId = await attach({ slug: 'airtable', name: 'Key base', apiKey: 'pat-revoked' });
    network((url) =>
      url.includes('api.airtable.com')
        ? json({ error: { type: 'AUTHENTICATION_REQUIRED' } }, 401)
        : refused(),
    );
    const job1 = await runJob([[{ toolName: 'airtable_list_bases', args: {} }], [finish]]);
    expect(job1.requests[1]!.prompt).toContain(`Key base ${DISCONNECTED}`);
    expect(await readConnectionState(db, { kind: 'connector', id: connectorId })).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
    const job2 = await runJob([[finish]]);
    expect(job2.requests[0]!.prompt).toContain(`Key base ${DISCONNECTED}`);
    expect(job2.requests[0]!.tools.filter((t) => t.startsWith('airtable_'))).toEqual([]);
  }, 60_000);
});

describe('each cause its own state and words', () => {
  it('a connector whose credential was deleted is present in the job with its state, never dropped', async () => {
    await attach({ slug: 'gmail', name: 'Mailbox', credentialId: null });
    network(() => refused());
    const job = await runJob([[finish]]);
    const context = job.requests[0]!.prompt;
    expect(context).toContain(`Mailbox ${DISCONNECTED}: its credential was deleted`);
    expect(job.requests[0]!.tools.filter((t) => t.startsWith('gmail_'))).toEqual([]);
  }, 60_000);

  it('a grant that covers none of the rights a connector needs: needs_reauth, the missing scopes named', async () => {
    const credentialId = await oauthCredential({
      type: 'google-oauth',
      scopes: 'https://www.googleapis.com/auth/drive.file',
    });
    await attach({ slug: 'gmail', name: 'Mail', credentialId });
    network(() => refused());
    const job = await runJob([[finish]]);
    const context = job.requests[0]!.prompt;
    expect(context).toContain(`Mail (account "owner@example.test") ${DISCONNECTED}`);
    expect(context).toContain('its authorisation lacks rights it needs');
    expect(context).toContain('https://www.googleapis.com/auth/gmail');
  }, 60_000);

  it('a credential that cannot be decrypted is broken, said as such', async () => {
    const [cred] = await db
      .insert(credentials)
      .values({
        ownerUserId: seed.userId,
        name: 'unreadable',
        type: 'google-oauth',
        payload: 'enc:v1:aa:bb:cc',
      })
      .returning();
    await attach({ slug: 'google-drive', name: 'Drive', credentialId: cred!.id });
    network(() => refused());
    const job = await runJob([[finish]]);
    expect(job.requests[0]!.prompt).toContain(
      `Drive ${DISCONNECTED}: its stored secret cannot be decrypted by this installation`,
    );
  }, 60_000);

  it('a provider that cannot be reached: unreachable with a retry time, the tool still offered next job', async () => {
    const connectorId = await attach({ slug: 'airtable', name: 'Flaky base', apiKey: 'pat-ok' });
    network((url) => {
      if (!url.includes('api.airtable.com')) refused();
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.airtable.com'), {
          code: 'ENOTFOUND',
        }),
      });
    });
    const job1 = await runJob([[{ toolName: 'airtable_list_bases', args: {} }], [finish]]);
    expect(job1.requests[1]!.prompt).toContain(
      'Flaky base is unreachable: the provider could not be reached',
    );
    expect(job1.requests[1]!.prompt).toContain('Next attempt after');
    const state = await readConnectionState(db, { kind: 'connector', id: connectorId });
    expect(state).toMatchObject({ state: 'unreachable', cause: 'network' });
    expect(state.retryAfter!.getTime()).toBeGreaterThan(Date.now());

    // Unreachable is not disconnected: the next job still holds the tool,
    // and a success puts the connector back to working.
    network((url) => (url.includes('api.airtable.com') ? json({ bases: [] }) : refused()));
    const job2 = await runJob([[{ toolName: 'airtable_list_bases', args: {} }], [finish]]);
    expect(job2.requests[0]!.prompt).not.toContain('Flaky base is');
    expect(await readConnectionState(db, { kind: 'connector', id: connectorId })).toMatchObject({
      state: 'working',
      cause: 'succeeded',
    });
  }, 60_000);

  it('authorising again (the state written working) gives the connector back at the next job', async () => {
    const credentialId = await oauthCredential({ type: 'airtable-oauth', scopes: airtableScopes });
    await attach({ slug: 'airtable-oauth', name: 'Base again', credentialId });
    await recordConnectionState(
      db,
      { kind: 'credential', id: credentialId },
      {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: '400 invalid_grant',
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    network(() => refused());
    const before = await runJob([[finish]]);
    expect(before.requests[0]!.prompt).toContain(
      `Base again (account "owner@example.test") ${DISCONNECTED}`,
    );

    await recordConnectionState(
      db,
      { kind: 'credential', id: credentialId },
      {
        state: 'working',
        cause: 'authorised',
        detail: null,
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    const after = await runJob([[finish]]);
    expect(after.requests[0]!.prompt).not.toContain(DISCONNECTED);
    expect(after.requests[0]!.prompt).toContain('airtable_list_bases');
  }, 60_000);
});

describe('the credential is read when it is used', () => {
  it('five connectors of one provider, token endpoint unreachable: a job that calls none of them sends no token request', async () => {
    const credentialId = await oauthCredential({
      type: 'google-oauth',
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://mail.google.com/',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
      ].join(' '),
      expired: true,
    });
    for (const slug of [
      'google-drive',
      'gmail',
      'google-calendar',
      'google-sheets',
      'google-docs',
    ]) {
      await attach({ slug, name: slug, credentialId });
    }
    // An endpoint that takes a second to fail, as an unreachable host does.
    const seen = network(async (url) => {
      if (url !== GOOGLE_TOKEN_URL) refused();
      await new Promise((r) => setTimeout(r, 1_000));
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      });
    });
    const job = await runJob([[finish]]);
    const firstModelCall = job.requests[0]!.at;
    // Measured: claim to first model call. Reported in the PR.
    process.stderr.write(
      `[measure] claim to first model call, 5 Google connectors, token endpoint unreachable: ${Math.round(
        firstModelCall - job.claimedAt,
      )} ms, token requests before it: ${seen.filter((s) => s.at < firstModelCall).length}
`,
    );
    expect(seen).toEqual([]);
    expect(job.requests[0]!.tools.length).toBeGreaterThan(0);
    expect(job.requests[0]!.prompt).not.toContain(DISCONNECTED);
  }, 60_000);
});

describe('the same states for an MCP server', () => {
  it('a server whose command does not start: broken, named in the context, and not started again by the next job', async () => {
    const [server] = await db
      .insert(mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Local db',
        slug: 'local-db',
        transport: 'stdio',
        command: 'nodal-no-such-mcp-server-command',
        args: [],
      })
      .returning();
    await db.insert(agentMcpServers).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      mcpServerId: server!.id,
    });
    network(() => refused());

    const job1 = await runJob([[finish]]);
    const state1 = await readConnectionState(db, { kind: 'mcp_server', id: server!.id });
    expect(state1).toMatchObject({ state: 'broken', cause: 'command_not_found' });
    expect(job1.requests[0]!.prompt).toContain(
      `Local db ${DISCONNECTED}: its command could not be started`,
    );
    expect(job1.requests[0]!.prompt).toContain('the MCP servers page');

    // The next job reads the state and does not spawn it again: the stored
    // observation is the first job's, unchanged.
    const job2 = await runJob([[finish]]);
    expect(job2.requests[0]!.prompt).toContain(`Local db ${DISCONNECTED}`);
    const state2 = await readConnectionState(db, { kind: 'mcp_server', id: server!.id });
    expect(state2.observedAt!.getTime()).toBe(state1.observedAt!.getTime());
  }, 60_000);
});
