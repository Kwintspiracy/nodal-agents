// voice-turn.test.ts — le tour DIT, de bout en bout, par la route (#941).
//
// Le chemin RÉEL : la route du runner (createApp, sa garde), l'audio envoyé par
// morceaux, la transcription de packages/speech sur la clé OpenRouter de
// l'espace, le tour de chat (`runChatTurn`, par `playChatTurn`), la voix, et le
// job lancé par `run_task` exécuté par `executeJob`. Une seule frontière est
// remplacée : le réseau, lu à `fetch`. Chaque requête qui part vers le
// fournisseur est gardée telle qu'il la reçoit ; les assertions portent sur
// ces corps et sur les lignes en base.
//
// L'audio est un ENREGISTREMENT : `fixtures/voice-turn-question.wav`, une voix
// de synthèse Windows (SAPI, « What time is it in Tokyo? »), 16 kHz mono
// 16 bits, écrite avec un bloc `fmt ` de 18 octets — l'en-tête que les
// enregistreurs écrivent, pas celui que `pcmToWav` produit. 72 480 octets
// d'échantillons : 2 265 ms.
//
// Mutations vérifiées (chacune rougit au moins un cas ci-dessous) :
//   - la ligne `rendering: spoken` retirée du prompt (`replyRenderingLine`
//     rend `null`) → « question », « task request » rougissent ;
//   - `replyRendering` non transmis au job par `run_task` → « task request » ;
//   - un second outil offert au tour vocal à côté de `run_task` → « question » ;
//   - la garde « rien entendu » retirée (durée 0 ou transcription vide) : un
//     message vide est rangé → les deux cas « nothing heard » rougissent ;
//   - `spokenMs` non rangé sur le message de la personne → « question » ;
//   - la lecture d'un morceau rendue à `c.req.arrayBuffer()` (le corps entier
//     alloué avant le refus) → « a chunked body larger than the turn may
//     still accept » (revue de #958, passe 1).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  chatMessages,
  conversations,
  entities,
  entityLlmKeys,
  approvalRules,
  agentMemory,
  toolCalls,
  and,
  eq,
  asc,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { AuthProvider, AuthSession } from '@nodal-agents/auth';
import { pcmToWav } from '@nodal-agents/speech';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { TITLE_SYSTEM_PROMPT } from '../../chat/conversation-title.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';
import { openUtterances, VOICE_LIMITS } from '../../chat/voice-utterances.ts';

// Provider calls leave through packages/llm's own transport (#608): routed back
// to the global fetch, so the stub below is the network boundary — for the
// model, the transcription and the voice alike.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const FIXTURE = new Uint8Array(
  readFileSync(new URL('../fixtures/voice-turn-question.wav', import.meta.url)),
);
/** The samples of the fixture: after its 46-byte header (12 RIFF + 26 fmt + 8 data). */
const FIXTURE_PCM = FIXTURE.subarray(46);
const FIXTURE_MS = 2265;
const TRANSCRIPT = 'What time is it in Tokyo?';
/** What the voice vendor answers: raw 16-bit PCM, as Gemini TTS does. */
const VOICE_PCM = Uint8Array.from({ length: 480 }, (_, i) => i % 251);

const SPOKEN_LINE = '- rendering: spoken';

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'bearer-token',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: 'unused-in-this-test',
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

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentId = '';

function makeDeps(authProvider: AuthProvider = new LocalTrustProvider()): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider,
    close: async () => {},
  };
}

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
    })
    .returning();
  agentId = agent!.id;
});

beforeEach(async () => {
  await db.delete(chatMessages);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, agentId));
  await db.delete(conversations).where(eq(conversations.agentId, agentId));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Sent = Array<{ role: string; content: unknown }>;
interface ChatBody {
  stream?: boolean;
  messages: Sent;
  tools?: Array<{ function: { name: string } }>;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

const systemOf = (body: ChatBody) =>
  textOf(body.messages.find((m) => m.role === 'system')?.content);

/**
 * Le réseau. La transcription répond `transcription` ; le FRONT (l'appel qui
 * propose `run_task`) répond par `front` ; la voix rend `VOICE_PCM`. Chaque
 * requête est gardée telle que le fournisseur la reçoit.
 */
function network(opts: {
  transcription?: { status: number; body: unknown };
  front?: { text?: string; instruction?: string };
  /** The tool calls the worker makes, one per request, before it answers 'Done.'. */
  worker?: Array<{ name: string; args: Record<string, unknown> }>;
}) {
  const workerCalls = [...(opts.worker ?? [])];
  const sent = {
    transcription: [] as Array<{ model: string; messages: Sent }>,
    front: [] as ChatBody[],
    worker: [] as ChatBody[],
    speech: [] as Array<Record<string, unknown>>,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/audio/speech')) {
        sent.speech.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return new Response(VOICE_PCM, {
          status: 200,
          headers: { 'content-type': 'audio/pcm' },
        });
      }
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as ChatBody & { model: string };
      const first = body.messages[0]?.content;
      const isAudio =
        Array.isArray(first) && first.some((p) => (p as { type?: unknown }).type === 'input_audio');
      if (isAudio) {
        sent.transcription.push({ model: body.model, messages: body.messages });
        const t = opts.transcription ?? {
          status: 200,
          body: { choices: [{ message: { role: 'assistant', content: TRANSCRIPT } }] },
        };
        return new Response(JSON.stringify(t.body), {
          status: t.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const system = systemOf(body);
      const last = textOf(body.messages[body.messages.length - 1]?.content);
      const isFront = (body.tools ?? []).some((t) => t.function.name === 'run_task');
      let text = 'ok';
      let toolCall: { name: string; args: Record<string, unknown> } | null = null;
      if (system.startsWith(TITLE_SYSTEM_PROMPT.slice(0, 40))) text = 'Tokyo time';
      else if (last.endsWith(ACTION_RECHECK)) text = 'ok';
      else if (isFront) {
        sent.front.push(body);
        const front = opts.front ?? {};
        text = front.text ?? '';
        if (front.instruction !== undefined) {
          toolCall = { name: 'run_task', args: { instruction: front.instruction } };
        }
      } else {
        sent.worker.push(body);
        const next = workerCalls.shift();
        if (next) {
          text = '';
          toolCall = next;
        } else text = 'Done.';
      }
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const finish = toolCall ? 'tool_calls' : 'stop';
      const calls = toolCall
        ? [
            {
              id: 'call_1',
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
            },
          ]
        : undefined;
      if (body.stream === true) {
        const delta: Record<string, unknown> = { role: 'assistant' };
        if (text) delta['content'] = text;
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
  return sent;
}

async function conversation(entityId = seed.entityId, owner = agentId): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId, agentId: owner, title: '', channel: 'dashboard' })
    .returning({ id: conversations.id });
  return conv!.id;
}

const AUTH = { Authorization: 'Bearer test-secret' };

function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  const raw = body instanceof Uint8Array;
  const payload: BodyInit | undefined =
    body === undefined ? undefined : raw ? Buffer.from(body) : JSON.stringify(body);
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }),
          ...headers,
        },
        ...(payload === undefined ? {} : { body: payload }),
      }),
    ),
  );
}

/** The `say` gesture as a client makes it: start, the audio in chunks, end. */
async function say(
  app: ReturnType<typeof createApp>,
  conversationId: string,
  audio: Uint8Array,
  format: { format: 'audio/wav' } | { format: 'audio/pcm'; sampleRate: number },
  chunks = 3,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const start = await call(app, 'POST', '/api/voice/turns', {
    entityId: seed.entityId,
    conversationId,
    ...format,
  });
  expect(start.status).toBe(201);
  const { turnId } = (await start.json()) as { turnId: string };
  const size = Math.ceil(audio.length / chunks);
  for (let seq = 0; seq * size < audio.length; seq++) {
    const res = await call(
      app,
      'POST',
      `/api/voice/turns/${turnId}/chunks/${seq}`,
      audio.slice(seq * size, (seq + 1) * size),
    );
    expect(res.status).toBe(200);
  }
  const end = await call(app, 'POST', `/api/voice/turns/${turnId}/end`);
  return { status: end.status, body: (await end.json()) as Record<string, unknown> };
}

async function rows(conversationId: string) {
  return db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      spokenMs: chatMessages.spokenMs,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt));
}

async function jobsOf(conversationId: string) {
  return db
    .select({
      id: agentJobs.id,
      task: agentJobs.task,
      status: agentJobs.status,
      replyRendering: agentJobs.replyRendering,
      systemPrompt: agentJobs.systemPrompt,
    })
    .from(agentJobs)
    .where(eq(agentJobs.conversationId, conversationId));
}

/** The job the turn launched runs in the background (`playChatTurn`): wait for its end. */
async function settled(jobId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [j] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    if (j && ['completed', 'failed', 'cancelled'].includes(j.status ?? '')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe('the voice turn route @cap:parler-a-un-agent/moteur', () => {
  it('a question: transcript, the agent’s reply, the reply spoken — the message stored as spoken, no job', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({ front: { text: 'It is nine in the evening in Tokyo.' } });

    const { status, body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: 'replied',
      transcript: TRANSCRIPT,
      durationMs: FIXTURE_MS,
      reply: 'It is nine in the evening in Tokyo.',
      spawnedJobId: null,
      speechError: null,
    });
    // The bytes the client sent, in order, are what the transcriber received.
    expect(sent.transcription).toHaveLength(1);
    const audioPart = (
      sent.transcription[0]!.messages[0]!.content as Array<Record<string, unknown>>
    )[1];
    expect(audioPart).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from(FIXTURE).toString('base64'), format: 'wav' },
    });
    // The voice read the agent's words, and the client got the WAV of what it said.
    expect(sent.speech).toHaveLength(1);
    expect(sent.speech[0]).toMatchObject({
      input: 'It is nine in the evening in Tokyo.',
      voice: 'Kore',
    });
    const audio = body['audio'] as { mimeType: string; base64: string };
    expect(audio.mimeType).toBe('audio/wav');
    expect(Buffer.from(audio.base64, 'base64')).toEqual(
      Buffer.from(pcmToWav(VOICE_PCM, { sampleRate: 24_000 })),
    );
    // The turn is the dashboard chat turn: run_task its only tool, the
    // transcript the person's words, and the prompt says the reply is heard.
    expect(sent.front).toHaveLength(1);
    const front = sent.front[0]!;
    expect((front.tools ?? []).map((t) => t.function.name)).toEqual(['run_task']);
    expect(textOf(front.messages[front.messages.length - 1]!.content)).toContain(TRANSCRIPT);
    expect(systemOf(front)).toContain(SPOKEN_LINE);

    expect(await rows(conv)).toEqual([
      { role: 'user', content: TRANSCRIPT, spokenMs: FIXTURE_MS },
      { role: 'assistant', content: 'It is nine in the evening in Tokyo.', spokenMs: null },
    ]);
    expect(await jobsOf(conv)).toEqual([]);
    expect(openUtterances()).toBe(0);
  });

  it('raw PCM with its announced rate is the same utterance: same bytes heard, same duration', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({ front: { text: 'Nine in the evening.' } });

    const { body } = await say(
      app,
      conv,
      FIXTURE_PCM,
      { format: 'audio/pcm', sampleRate: 16_000 },
      5,
    );

    expect(body).toMatchObject({
      outcome: 'replied',
      transcript: TRANSCRIPT,
      durationMs: FIXTURE_MS,
    });
    const audioPart = (
      sent.transcription[0]!.messages[0]!.content as Array<Record<string, unknown>>
    )[1];
    expect(audioPart).toEqual({
      type: 'input_audio',
      input_audio: {
        data: Buffer.from(pcmToWav(FIXTURE_PCM, { sampleRate: 16_000 })).toString('base64'),
        format: 'wav',
      },
    });
    expect((await rows(conv))[0]).toEqual({
      role: 'user',
      content: TRANSCRIPT,
      spokenMs: FIXTURE_MS,
    });
  });

  it('a task request: run_task launches a job that inherits the spoken rendering, and its prompt says so', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({ front: { text: 'On it, I am checking.', instruction: '' } });

    const { body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(body).toMatchObject({
      outcome: 'replied',
      transcript: TRANSCRIPT,
      reply: 'On it, I am checking.',
    });
    expect(typeof body['spawnedJobId']).toBe('string');
    // The acknowledgement is the agent's own line, and it is spoken.
    expect(sent.speech[0]).toMatchObject({ input: 'On it, I am checking.' });

    const jobId = body['spawnedJobId'] as string;
    await settled(jobId);
    const [job] = await jobsOf(conv);
    expect(job).toMatchObject({ id: jobId, task: TRANSCRIPT, replyRendering: 'spoken' });
    expect(job!.systemPrompt).toContain(SPOKEN_LINE);
    // The worker's request, as the provider received it, carries the fact.
    expect(sent.worker.length).toBeGreaterThan(0);
    expect(systemOf(sent.worker[0]!)).toContain(SPOKEN_LINE);
  });

  it('the job a voice turn launches writes its autonomy rows at start, so its tool calls run (#917)', async () => {
    // The voice turn's `run_task` is the chat surface's own tool: runChatTurn
    // reads it off the reply, it never goes through the gate. The gate applies
    // inside the JOB, and the job start writes a row for every tool it holds
    // (`writeMissingAutonomyRows`, execute.ts). An agent with no row at all:
    // its first call must run on the written row, never `autonomy_not_set`.
    await db.delete(approvalRules).where(eq(approvalRules.agentId, agentId));
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const fact = `voice-917-${randomUUID()}`;
    network({
      front: { text: 'On it.', instruction: '' },
      worker: [{ name: 'save_memory', args: { fact, category: 'context' } }],
    });

    const { body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    const jobId = body['spawnedJobId'] as string;
    await settled(jobId);

    const [job] = await db
      .select({ status: agentJobs.status, tools: agentJobs.systemPromptTools })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job?.status).toBe('completed');
    const named = new Set(
      (
        await db
          .select({ toolName: approvalRules.toolName })
          .from(approvalRules)
          .where(eq(approvalRules.agentId, agentId))
      ).map((r) => r.toolName),
    );
    expect((job?.tools ?? []).filter((t) => !named.has(t))).toEqual([]);
    const calls = await db
      .select({ output: toolCalls.toolOutput })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, 'save_memory')));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.output ?? '').not.toContain('autonomy_not_set');
    const saved = await db
      .select({ fact: agentMemory.fact })
      .from(agentMemory)
      .where(eq(agentMemory.fact, fact));
    expect(saved).toHaveLength(1);
    await db.delete(agentMemory).where(eq(agentMemory.fact, fact));
  });

  it('the typed turn is unchanged: no spoken line, no duration, its job rendered as text', async () => {
    // The control the general rule needs: the rendering belongs to the turn,
    // not to the dashboard channel, which still serves typed messages.
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({ front: { text: 'Launching.', instruction: '' } });

    const res = await call(app, 'POST', '/api/chat', {
      entityId: seed.entityId,
      agentId,
      conversationId: conv,
      message: TRANSCRIPT,
    });
    expect(res.status).toBe(200);

    expect(systemOf(sent.front[0]!)).not.toContain('- rendering:');
    expect((await rows(conv))[0]).toEqual({ role: 'user', content: TRANSCRIPT, spokenMs: null });
    const [job] = await jobsOf(conv);
    expect(job).toMatchObject({ task: TRANSCRIPT, replyRendering: 'text' });
    await settled(job!.id);
    const [done] = await jobsOf(conv);
    expect(done!.systemPrompt).not.toContain('- rendering:');
  });

  it('nothing heard: a turn ended with no audio stores nothing and asks no vendor', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({});

    const { status, body } = await say(app, conv, new Uint8Array(0), {
      format: 'audio/pcm',
      sampleRate: 16_000,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'nothing_heard', durationMs: 0 });
    expect(sent.transcription).toEqual([]);
    expect(sent.front).toEqual([]);
    expect(await rows(conv)).toEqual([]);
  });

  it('nothing heard: audio with no words in it stores nothing and starts no turn', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({
      transcription: {
        status: 200,
        body: { choices: [{ message: { role: 'assistant', content: '' } }] },
      },
    });

    const { status, body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'nothing_heard', durationMs: FIXTURE_MS });
    expect(sent.transcription).toHaveLength(1);
    expect(sent.front).toEqual([]);
    expect(await rows(conv)).toEqual([]);
  });

  it('a transcription error is stated, with the vendor’s words, and stores nothing', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({
      transcription: { status: 402, body: { error: { message: 'Insufficient credits' } } },
    });

    const { status, body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'transcription_failed',
      detail: 'openrouter: HTTP 402 — Insufficient credits',
    });
    expect(sent.front).toEqual([]);
    expect(await rows(conv)).toEqual([]);
  });

  it('a chunk out of order is refused, never placed where it was guessed to go', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    network({});
    const start = await call(app, 'POST', '/api/voice/turns', {
      entityId: seed.entityId,
      conversationId: conv,
      format: 'audio/wav',
    });
    const { turnId } = (await start.json()) as { turnId: string };

    const res = await call(
      app,
      'POST',
      `/api/voice/turns/${turnId}/chunks/1`,
      FIXTURE.slice(0, 10),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'chunk_out_of_order', expected: 0 });

    const cancel = await call(app, 'DELETE', `/api/voice/turns/${turnId}`);
    expect(await cancel.json()).toEqual({ cancelled: true });
    const end = await call(app, 'POST', `/api/voice/turns/${turnId}/end`);
    expect(end.status).toBe(404);
    expect(await rows(conv)).toEqual([]);
  });

  it('the start states a workspace with no speech key before anyone speaks', async () => {
    const [other] = await db
      .insert(entities)
      .values({ userId: seed.userId, name: 'No key', slug: `nokey-${randomUUID()}` })
      .returning();
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation(other!.id, agentId);
    network({});

    const res = await call(app, 'POST', '/api/voice/turns', {
      entityId: other!.id,
      conversationId: conv,
      format: 'audio/wav',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'speech_not_configured' });
  });
});

describe('the voice turn route — the runner gate @cap:se-connecter/moteur', () => {
  it('local-auth: every path of the turn refuses a request with no credential', async () => {
    const app = createApp(makeDeps({ getSession: async () => null }), {
      ...testEnv,
      AUTH_MODE: 'local-auth',
    });
    const conv = await conversation();
    network({});
    const id = randomUUID();
    const none = {};
    for (const [method, path, body] of [
      [
        'POST',
        '/api/voice/turns',
        { entityId: seed.entityId, conversationId: conv, format: 'audio/wav' },
      ],
      ['POST', `/api/voice/turns/${id}/chunks/0`, FIXTURE.slice(0, 10)],
      ['POST', `/api/voice/turns/${id}/end`, undefined],
      ['DELETE', `/api/voice/turns/${id}`, undefined],
    ] as const) {
      const res = await call(app, method, path, body, none);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({ error: 'AUTH_REQUIRED' });
    }
    expect(openUtterances()).toBe(0);
  });

  it('bearer-token: a session reaches its own entity’s turns only', async () => {
    class SessionOf implements AuthProvider {
      constructor(private readonly session: AuthSession) {}
      getSession(req: Request): Promise<AuthSession | null> {
        return Promise.resolve(req.headers.get('x-test-session') === '1' ? this.session : null);
      }
    }
    const [other] = await db
      .insert(entities)
      .values({ userId: seed.userId, name: 'Other', slug: `other-${randomUUID()}` })
      .returning();
    const app = createApp(
      makeDeps(new SessionOf({ userId: seed.userId, entityId: other!.id })),
      testEnv,
    );
    const conv = await conversation();
    network({});

    // A turn of the seeded entity, opened by the trusted caller.
    const start = await call(app, 'POST', '/api/voice/turns', {
      entityId: seed.entityId,
      conversationId: conv,
      format: 'audio/wav',
    });
    const { turnId } = (await start.json()) as { turnId: string };

    const session = { 'x-test-session': '1' };
    const forbidden = await call(
      app,
      'POST',
      '/api/voice/turns',
      { entityId: seed.entityId, conversationId: conv, format: 'audio/wav' },
      session,
    );
    expect(forbidden.status).toBe(403);
    const chunk = await call(app, 'POST', `/api/voice/turns/${turnId}/chunks/0`, FIXTURE, session);
    expect(chunk.status).toBe(404);
    const end = await call(app, 'POST', `/api/voice/turns/${turnId}/end`, undefined, session);
    expect(end.status).toBe(404);

    await call(app, 'DELETE', `/api/voice/turns/${turnId}`);
    expect(await rows(conv)).toEqual([]);
  });
});

describe('the voice turn route — the audio read is capped (review of #958, pass 1) @cap:parler-a-un-agent/moteur', () => {
  /**
   * A body with no Content-Length, as `Transfer-Encoding: chunked` sends it,
   * that yields `chunk` bytes per read and only when asked (highWaterMark 0):
   * `pulled` is then exactly what the route read off the network.
   */
  function chunkedBody(total: number, chunk = 64 * 1024) {
    const counter = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (counter.pulled >= total) {
            controller.close();
            return;
          }
          const n = Math.min(chunk, total - counter.pulled);
          counter.pulled += n;
          controller.enqueue(new Uint8Array(n));
        },
        cancel() {
          counter.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, counter, chunk };
  }

  function sendStream(
    app: ReturnType<typeof createApp>,
    path: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<Response> {
    const init = {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' };
    const req = new Request(`http://localhost${path}`, init);
    expect(req.headers.get('content-length')).toBeNull();
    return Promise.resolve(app.fetch(req));
  }

  async function openTurn(app: ReturnType<typeof createApp>): Promise<string> {
    const conv = await conversation();
    network({});
    const start = await call(app, 'POST', '/api/voice/turns', {
      entityId: seed.entityId,
      conversationId: conv,
      format: 'audio/pcm',
      sampleRate: 16_000,
    });
    return ((await start.json()) as { turnId: string }).turnId;
  }

  it('a chunked body larger than the turn may still accept is refused with 413, after reading no more than the limit plus one network chunk', async () => {
    const app = createApp(makeDeps(), testEnv);
    const turnId = await openTurn(app);
    const body = chunkedBody(2 * VOICE_LIMITS.maxBytes);

    const res = await sendStream(app, `/api/voice/turns/${turnId}/chunks/0`, body.stream);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'audio_too_long' });
    expect(body.counter.pulled).toBeLessThanOrEqual(VOICE_LIMITS.maxBytes + body.chunk);
    expect(body.counter.cancelled).toBe(true);
    // The whole turn is dropped: half a sentence never becomes a message.
    const end = await call(app, 'POST', `/api/voice/turns/${turnId}/end`);
    expect(end.status).toBe(404);
  });

  it('a body exactly at the limit passes; one byte more on the next chunk is refused', async () => {
    const app = createApp(makeDeps(), testEnv);
    const turnId = await openTurn(app);

    const full = chunkedBody(VOICE_LIMITS.maxBytes);
    const res = await sendStream(app, `/api/voice/turns/${turnId}/chunks/0`, full.stream);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: VOICE_LIMITS.maxBytes });

    // The cap is what the TURN may still accept, not a per-chunk size.
    const extra = chunkedBody(1);
    const over = await sendStream(app, `/api/voice/turns/${turnId}/chunks/1`, extra.stream);
    expect(over.status).toBe(413);
    expect(await call(app, 'DELETE', `/api/voice/turns/${turnId}`).then((r) => r.status)).toBe(404);
  });
});
