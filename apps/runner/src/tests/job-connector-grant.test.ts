// job-connector-grant.test.ts — a job's connector tools follow the grant.
//
// The credential's stored scopes are what the provider granted. An operation
// whose rights are not all among them would be refused by the provider on
// every call, so the runner does not offer it. The assertions read the request
// the model actually received, on two providers (Google and Microsoft) and on
// a grant from before per-connector authorisation (Drive-only, Sheets bound).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
  agentConnectorAssignments,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Module-level mock registry ───────────────────────────────────────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
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
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('job-connector-grant.test: no active LLM client set');
      return active;
    },
  };
});

// ─── Test constants ────────────────────────────────────────────────────────────

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** An LLM that answers once, in text, and keeps every request it was sent. */
function makeCapturingLlmClient(): { client: RunnerDeps['llmClient']; requests: string[] } {
  const requests: string[] = [];
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      requests.push(JSON.stringify({ prompt: options.prompt, tools: options.tools ?? [] }));
      return {
        content: [{ type: 'text' as const, text: 'Done.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
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
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
  return { client, requests };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
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

/** Give the agent one OAuth connector whose credential holds `scopes`. */
async function assignConnector(opts: {
  slug: string;
  type: 'google-oauth' | 'microsoft-oauth';
  scopes: string;
}): Promise<void> {
  const [cred] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: `${opts.slug} credential`,
      type: opts.type,
      payload: encrypt(
        JSON.stringify({
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          clientId: 'cid',
          clientSecret: 'cs',
          scopes: opts.scopes,
          accountName: 'grant@example.com',
          tokenUrl: 'https://example.invalid/token',
        }),
      ),
    })
    .returning();
  const [conn] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: opts.slug,
      slug: opts.slug,
      authType: 'oauth2',
      active: true,
      credentialId: cred!.id,
    })
    .returning();
  await db.insert(agentConnectorAssignments).values({
    agentId: seed.agentId,
    connectorId: conn!.id,
    entityId: seed.entityId,
    enabledOperations: null,
  });
}

/** Run one job and return everything the model was sent. */
async function modelRequestOfAJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'What can you do with my mail?',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  const { client, requests } = makeCapturingLlmClient();
  await executeJob(job!.id as JobId, makeDeps(client), testEnv);
  expect(requests.length).toBeGreaterThan(0);
  return requests.join('\n');
}

async function clearAssignments(): Promise<void> {
  await db
    .delete(agentConnectorAssignments)
    .where(eq(agentConnectorAssignments.agentId, seed.agentId));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('a job is offered only the operations its credential grant covers @cap:assigner-outils/moteur', () => {
  it('Gmail on a read-only grant: the read operations reach the model, sending and deleting do not', async () => {
    await assignConnector({
      slug: 'gmail',
      type: 'google-oauth',
      scopes: 'https://www.googleapis.com/auth/gmail.readonly openid',
    });
    try {
      const sent = await modelRequestOfAJob();
      expect(sent).toContain('gmail_list_messages');
      expect(sent).toContain('gmail_get_thread');
      expect(sent).not.toContain('gmail_send_email');
      expect(sent).not.toContain('gmail_delete_message');
      expect(sent).not.toContain('gmail_create_draft');
    } finally {
      await clearAssignments();
    }
  });

  it('Outlook (another provider, short-form Graph scopes) on Mail.Read: reading stays, changing and sending are withheld', async () => {
    await assignConnector({
      slug: 'outlook-mail',
      type: 'microsoft-oauth',
      scopes: 'Mail.Read openid profile email',
    });
    try {
      const sent = await modelRequestOfAJob();
      expect(sent).toContain('outlook_list_messages');
      expect(sent).not.toContain('outlook_send_email');
      expect(sent).not.toContain('outlook_move_message');
    } finally {
      await clearAssignments();
    }
  });

  it('Sheets on a Drive-only grant (an install from before): every operation stays, Google accepts Drive for them', async () => {
    await assignConnector({
      slug: 'google-sheets',
      type: 'google-oauth',
      scopes: 'https://www.googleapis.com/auth/drive openid',
    });
    try {
      const sent = await modelRequestOfAJob();
      expect(sent).toContain('sheets_read_range');
      expect(sent).toContain('sheets_delete_sheet');
    } finally {
      await clearAssignments();
    }
  });
});
