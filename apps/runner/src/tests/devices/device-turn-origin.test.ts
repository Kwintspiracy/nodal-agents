// device-turn-origin.test.ts — the origin of a turn follows the request (#945).
//
// A turn made in a device's conversation, through the route the dashboard
// uses (`runChatTurn`, behind `/api/chat/stream` and `/api/voice/turns`),
// records the device: the job it launches carries `channel = 'device'` and the
// device as its chat — the facts every reader that answers back reads
// (approvals/notify.ts, the push stream). A dashboard turn is unchanged. A
// turn written into a messaging channel's thread is refused, before anything
// is stored.
//
// Then the readers of such a job, on its device's facts:
//   - its history is the conversation's `chat_messages`, like the dashboard's;
//   - its result is read on the device's stream, never pushed by the outbox.
//
// The real chat turn, the real test base, the real LLM client built from the
// agent's key; the provider's answer is a stub at the `fetch` boundary (the
// harness of handoff-verbatim.test.ts).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  chatMessages,
  conversations,
  devices,
  entityLlmKeys,
  eq,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { TITLE_SYSTEM_PROMPT } from '../../chat/conversation-title.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';
import { loadThreadHistory } from '../../job/thread-history.ts';
import { resolveDeliveryTarget } from '../../delivery/resolve-delivery-target.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentId = '';
let deviceId = '';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  const [key] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-test-key'),
      baseUrl: null,
      nickname: 'OpenRouter (test)',
      isActive: true,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Alfred',
      slug: `alfred-${randomUUID().slice(0, 8)}`,
      personality: 'You are a test agent.',
      role: 'orchestrator',
      llmKeyId: key!.id,
      model: 'z-ai/glm-5.3',
      // A messaging channel exists: a device's result must still not go there.
      telegramBotToken: '123:fake',
    })
    .returning();
  agentId = agent!.id;
  const [d] = await db
    .insert(devices)
    .values({ entityId: seed.entityId, name: 'Desk', capabilities: ['microphone', 'speaker'] })
    .returning({ id: devices.id });
  deviceId = d!.id;
});

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

type Sent = Array<{ role: string; content: unknown }>;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

/** The provider: the front escalates with `run_task`; titling and the recheck answer plainly. */
function network(instruction: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as {
        stream?: boolean;
        messages: Sent;
        tools?: Array<{ function: { name: string } }>;
      };
      const system = textOf(body.messages.find((m) => m.role === 'system')?.content);
      const last = textOf(body.messages[body.messages.length - 1]?.content);
      const isFront = (body.tools ?? []).some((t) => t.function.name === 'run_task');
      let text = 'ok';
      let call: { name: string; args: Record<string, unknown> } | null = null;
      if (system.startsWith(TITLE_SYSTEM_PROMPT.slice(0, 40))) text = 'Title';
      else if (last.endsWith(ACTION_RECHECK)) text = 'ok';
      else if (isFront) {
        text = 'On it.';
        call = { name: 'run_task', args: { instruction } };
      }
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const calls = call
        ? [
            {
              id: 'call_1',
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ]
        : undefined;
      const finish = call ? 'tool_calls' : 'stop';
      if (body.stream === true) {
        const delta: Record<string, unknown> = { role: 'assistant', content: text };
        if (calls) delta['tool_calls'] = calls.map((c, index) => ({ index, ...c }));
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const message: Record<string, unknown> = { role: 'assistant', content: text };
      if (calls) message['tool_calls'] = calls;
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message, finish_reason: finish }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

function makeDeps(): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function conversationOn(channel: string, chatId: string | null): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId, title: '', channel, chatId })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function turn(conversationId: string, message: string) {
  network('Prepare the summary.');
  return runChatTurn({
    deps: makeDeps(),
    entityId: seed.entityId,
    agentId,
    conversationId,
    message,
  });
}

async function jobOf(jobId: string) {
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  return row!;
}

describe('a turn made in a device’s conversation records the device (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('the job it launches carries channel device and the device as its chat', async () => {
    const conv = await conversationOn('device', deviceId);
    const r = await turn(conv, 'Summarise my notes, please.');
    expect(r.ok).toBe(true);
    const jobId = r.ok ? r.spawnedJobId : undefined;
    expect(jobId).toBeDefined();
    expect(await jobOf(jobId!)).toMatchObject({
      channel: 'device',
      chatId: deviceId,
      chatChannel: 'device',
      conversationId: conv,
      task: 'Summarise my notes, please.',
    });
  });

  it('a dashboard turn is unchanged: channel dashboard, no chat', async () => {
    const conv = await conversationOn('dashboard', null);
    const r = await turn(conv, 'Summarise my notes, please.');
    const jobId = r.ok ? r.spawnedJobId : undefined;
    expect(await jobOf(jobId!)).toMatchObject({
      channel: 'dashboard',
      chatId: null,
      chatChannel: null,
      conversationId: conv,
    });
  });

  it('a turn written into a messaging channel’s thread is refused, and nothing is stored', async () => {
    const conv = await conversationOn('telegram', '555');
    const r = await turn(conv, 'Hello?');
    expect(r).toEqual({ ok: false, error: 'conversation_not_chat' });
    expect(
      await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conv)),
    ).toEqual([]);
  });

  it('a device conversation that lost its device names nowhere to answer: refused', async () => {
    const conv = await conversationOn('device', null);
    expect(await turn(conv, 'Hello?')).toEqual({ ok: false, error: 'conversation_not_chat' });
  });
});

describe('the readers of a device’s job read the device’s facts (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('its history is the conversation’s chat_messages, like the dashboard’s', async () => {
    const conv = await conversationOn('device', deviceId);
    const first = await turn(conv, 'What is on my calendar today?');
    expect(first.ok).toBe(true);
    // The next turn's job: its history holds the first turn, as said.
    const second = await turn(conv, 'And tomorrow?');
    const secondJob = second.ok ? second.spawnedJobId! : '';
    const history = await loadThreadHistory({
      db: db as RunnerDeps['db'],
      conversationId: conv,
      channel: 'device',
      excludeJobId: secondJob,
      timezone: 'UTC',
    });
    const said = history
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n');
    expect(said).toContain('What is on my calendar today?');
  });

  it('its result is read on the device’s stream, never pushed by the outbox', async () => {
    expect(
      await resolveDeliveryTarget(db as RunnerDeps['db'], {
        chatId: deviceId,
        agentId,
        channel: 'device',
        chatChannel: 'device',
        triggerContext: null,
      }),
    ).toEqual({ refused: 'read_from_stream' });
    // The agent's messaging channel is still the outbox's for a chat on it.
    expect(
      await resolveDeliveryTarget(db as RunnerDeps['db'], {
        chatId: '555',
        agentId,
        channel: 'telegram',
        chatChannel: 'telegram',
        triggerContext: null,
      }),
    ).toEqual({ channel: 'telegram', chatId: '555' });
  });
});
