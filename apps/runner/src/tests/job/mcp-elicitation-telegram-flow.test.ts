// mcp-elicitation-telegram-flow.test.ts — le PARCOURS COMPLET d'une question
// posée par un serveur MCP pendant un appel (élicitation, 0145), quand la
// demande est née sur TELEGRAM : la question, son image et la réponse se font
// dans la conversation de la demande.
//
// Réel de bout en bout sauf le modèle et l'API Bot : le serveur est la fixture
// stdio construite avec le SDK officiel, le runner est `executeJob`, la carte
// part par le vrai adaptateur Telegram (seul `fetch` vers api.telegram.org est
// simulé), et les gestes entrent par la vraie porte Telegram du runner.
//
// Ce qui est relu : ce que l'API Bot a reçu (photo, carte, réécritures) dans
// QUELLE conversation, et ce que le SERVEUR dit avoir reçu (son outil le
// renvoie au transcript).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  approvalRequests,
  approvalRules,
  mcpServers,
  agentMcpServers,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import {
  handleTelegramElicitationCallback,
  handleTelegramElicitationReply,
} from '../../telegram/elicitation-callback.ts';
import type { JobId } from '@nodal-agents/orchestration';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../../packages/adapters/mcp/src/tests/fixtures/mcp-elicit-server.mjs',
    import.meta.url,
  ),
);

// ─── LLM client interception ─────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('mcp-elicitation-flow.test: no active LLM client');
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
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
}

const testEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  EMBEDDING_PROVIDER: 'keyword',
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
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
  // Court : un run qui attendrait une question que personne ne pose finit vite.
  NODALAI_ELICITATION_TIMEOUT_MS: 20_000,
} as unknown as RunnerEnv;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));
  const [server] = await db
    .insert(mcpServers)
    .values({
      entityId: seed.entityId,
      name: 'Printer',
      slug: 'printer',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envVars: {},
      active: true,
    })
    .returning();
  await db.update(agents).set({ telegramBotToken: BOT_TOKEN }).where(eq(agents.id, seed.agentId));
  await db.insert(telegramAllowedChats).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: OWNER_CHAT,
      role: 'owner',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: REQUEST_CHAT,
      role: 'member',
      status: 'active',
    },
  ]);
  await db.insert(agentMcpServers).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    mcpServerId: server!.id,
    enabledTools: null,
  });
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

const BOT_TOKEN = '123:fake';
const OWNER_CHAT = '555';
const REQUEST_CHAT = '777';

type BotCall = { method: string; chatId: unknown; body: Record<string, unknown> };
const bot: BotCall[] = [];
let nextMessageId = 900;

function stubTelegram(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.includes('api.telegram.org')) return new Response('ok');
    const method = url.slice(url.lastIndexOf('/') + 1);
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      body = { caption: init.body.get('caption'), chat_id: init.body.get('chat_id') };
    } else if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    bot.push({ method, chatId: body['chat_id'], body });
    const result =
      method === 'sendMessage' || method === 'sendPhoto' ? { message_id: nextMessageId++ } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
}

/** Le dernier clavier montré sur la carte (envoi ou réécriture). */
function keyboard(): Array<Array<{ text: string; callback_data: string }>> {
  const last = [...bot]
    .reverse()
    .find(
      (c) =>
        (c.method === 'sendMessage' || c.method === 'editMessageText') && c.body['reply_markup'],
    );
  return (
    (last?.body['reply_markup'] as { inline_keyboard: never } | undefined)?.inline_keyboard ?? []
  );
}

function buttonData(label: string): string {
  const hit = keyboard()
    .flat()
    .find((b) => b.text === label);
  if (!hit) throw new Error(`no button "${label}": ${JSON.stringify(keyboard())}`);
  return hit.callback_data;
}

let cardMessageId = 0;
let updateId = 1;

async function tapOn(label: string, deps: RunnerDeps): Promise<string | null> {
  const r = await handleTelegramElicitationCallback({
    update: {
      update_id: updateId++,
      callback_query: {
        id: `cb-${updateId}`,
        data: buttonData(label),
        message: { message_id: cardMessageId, chat: { id: Number(REQUEST_CHAT), type: 'private' } },
      },
    },
    receivingAgentId: seed.agentId,
    botToken: BOT_TOKEN,
    deps,
    env: testEnv,
  });
  return r?.notice ?? null;
}

async function typeReply(text: string, deps: RunnerDeps): Promise<void> {
  await handleTelegramElicitationReply({
    update: {
      update_id: updateId++,
      message: {
        message_id: updateId,
        chat: { id: Number(REQUEST_CHAT), type: 'private' },
        text,
        reply_to_message: { message_id: cardMessageId },
      },
    },
    receivingAgentId: seed.agentId,
    deps,
  });
}

async function waitForCard(): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    const card = bot.find((c) => c.method === 'sendMessage' && c.body['reply_markup']);
    if (card) {
      cardMessageId = nextMessageId - 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no question card reached Telegram');
}

async function toolResultTexts(jobId: string): Promise<string[]> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  const out: string[] = [];
  for (const msg of (row?.messages ?? []) as Array<{ role: string; content: unknown }>) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool-result') continue;
      const output = block['output'] as { type: string; value: unknown } | undefined;
      const raw = output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
      out.push(typeof raw === 'string' ? raw : JSON.stringify(raw));
    }
  }
  return out;
}

describe('une question de serveur MCP, demandée sur Telegram, répondue sur Telegram @cap:approuver-une-action/moteur', () => {
  it('image et carte dans la conversation de la demande ; gestes et réponse tapée ; le serveur reçoit le formulaire', async () => {
    stubTelegram();
    await db.delete(approvalRules).where(eq(approvalRules.toolName, 'printer__order'));
    await db.insert(approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'printer__order',
      action: 'auto_approve',
    });
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: REQUEST_CHAT,
        chatChannel: 'telegram',
        task: 'print the report',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-print-1',
              toolName: 'printer__order',
              args: { purpose: 'Print the report', attach: true },
            },
          ],
        },
        // Sur Telegram, l'agent livre sa réponse par l'outil d'envoi.
        {
          toolCalls: [
            {
              toolCallId: 'tc-send',
              toolName: 'telegram_send_message',
              args: { text: 'Printed in grayscale, two copies.' },
            },
          ],
        },
        {
          text: 'Done.',
          toolCalls: [
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );
    const run = executeJob(job!.id as JobId, deps, testEnv);

    await waitForCard();
    // L'image d'abord, puis la carte : dans la conversation de la DEMANDE, jamais
    // dans celle du propriétaire. La pièce qui n'est pas une image n'est pas partie.
    const outbound = bot.filter((c) => c.method === 'sendPhoto' || c.method === 'sendMessage');
    expect(outbound.map((c) => [c.method, String(c.chatId)])).toEqual([
      ['sendPhoto', REQUEST_CHAT],
      ['sendMessage', REQUEST_CHAT],
    ]);
    expect(outbound[0]!.body['caption']).toBe('Page 1 preview');
    expect(String(outbound[1]!.body['text'])).toContain('« How should "report.pdf" be printed? »');

    expect(await tapOn('Color: grayscale', deps)).toBeNull();
    expect(await tapOn('Two-sided: Yes', deps)).toBeNull();
    expect(await tapOn('✏️ Copies', deps)).toBe('Reply to the card with Copies.');
    await typeReply('2', deps);
    expect(await tapOn('✅ Send', deps)).toBe('Sent.');

    const result = await run;
    expect(result.status).toBe('completed');
    const texts = await toolResultTexts(job!.id);
    expect(
      texts.some((t) =>
        t.includes('{"action":"accept","content":{"color":"grayscale","copies":2,"duplex":true}}'),
      ),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job!.id), eq(approvalRequests.kind, 'elicitation')));
    expect(row!.resolvedBy).toBe('telegram');
    // Rien n'a été envoyé dans la conversation du propriétaire.
    expect(bot.filter((c) => String(c.chatId) === OWNER_CHAT)).toEqual([]);
  }, 60_000);
});
