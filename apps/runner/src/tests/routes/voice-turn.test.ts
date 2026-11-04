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
  cancelJobs,
  channelBindings,
  inTransaction,
  llmCalls,
  telegramAllowedChats,
  readVoiceSetting,
  writeVoiceSetting,
} from '@nodal-agents/db';
import { clearVoiceCatalog } from '../../job/resolve-voice.ts';
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
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { openUtterances, VOICE_LIMITS } from '../../chat/voice-utterances.ts';
import { finalizeJobFailure, finalizeJobSuccess } from '../../job/finalize.ts';
import { publishJobEnded } from '../../events/publish.ts';
import { speakFinishedJob } from '../../chat/job-reply-voice.ts';

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

/** A promise the test resolves: what a held answer waits for. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Le réseau. La transcription répond `transcription` ; le FRONT (l'appel qui
 * propose `run_task`) répond par `front` ; la voix rend `VOICE_PCM`. Chaque
 * requête est gardée telle que le fournisseur la reçoit.
 *
 * #943 : `front.parts` fait écrire la réponse en plusieurs fragments, et
 * `front.holdBefore` retient le fragment de ce rang jusqu'à `front.hold` — un
 * modèle qui n'a pas fini d'écrire. `recheck.hold` retient la relecture
 * d'escalade ; `recheck.instruction` lui fait lancer un `run_task`. `speech`
 * remplace la réponse de la voix, phrase par phrase. `log` dit, dans l'ordre,
 * quand le front a fini et quand la relecture a commencé.
 */
function network(opts: {
  /** The transcription answer: one for every request, or one per request's audio (#976). */
  transcription?:
    | { status: number; body: unknown }
    | ((audioBase64: string) => { status: number; body: unknown });
  front?: {
    text?: string;
    instruction?: string;
    parts?: string[];
    holdBefore?: number;
    hold?: Promise<void>;
  };
  recheck?: { hold?: Promise<void>; instruction?: string };
  speech?: (input: string, n: number) => Response | Promise<Response>;
  /** #969 — Google direct: its answer to `streamGenerateContent`, one per sentence. */
  google?: (input: string) => Response | Promise<Response>;
  /** The tool calls the worker makes, one per request, before it answers 'Done.'. */
  worker?: Array<{ name: string; args: Record<string, unknown> }>;
  /** #967 — what the worker answers instead of 'Done.'. */
  workerReply?: string;
  /** #967 — the agent's announcement of a finished voice job: its text, or a refusal. */
  announcement?: { text?: string; status?: number };
}) {
  const workerCalls = [...(opts.worker ?? [])];
  const sent = {
    transcription: [] as Array<{ url: string; body: Record<string, unknown> }>,
    front: [] as ChatBody[],
    worker: [] as ChatBody[],
    speech: [] as Array<Record<string, unknown>>,
    google: [] as Array<{ url: string; key: string | null; body: Record<string, unknown> }>,
    announcement: [] as ChatBody[],
    log: [] as string[],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      // #969 — the speech models each source lists (a trimmed copy of the
      // real answers of 2026-11-03).
      if (url.includes('/models?output_modalities=speech')) {
        return Response.json({
          data: [
            {
              id: 'google/gemini-3.8-flash-tts',
              name: 'Google: Gemini 3.8 Flash TTS',
              supported_voices: ['Kore', 'Puck'],
            },
            {
              id: 'x-ai/grok-voice-tts-1.0',
              name: 'SpaceXAI: Grok Voice TTS 1.0',
              supported_voices: ['eve', 'ara', 'rex', 'sal', 'leo'],
            },
            {
              id: 'minimax/speech-2.8-turbo',
              name: 'MiniMax: Speech 2.8 Turbo',
              supported_voices: ['English_CalmWoman'],
            },
          ],
        });
      }
      if (url.includes('/models?output_modalities=transcription')) {
        return Response.json({
          data: [
            { id: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' },
            { id: 'deepgram/nova-3', name: 'Deepgram: Nova-3' },
            { id: 'openai/gpt-transcribe', name: 'OpenAI: GPT Transcribe' },
          ],
        });
      }
      if (url.includes('generativelanguage.googleapis.com/v1beta/models?')) {
        return Response.json({
          models: [
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
            { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS' },
          ],
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        const body = JSON.parse(init?.body as string) as {
          contents: Array<{ parts: Array<{ text: string }> }>;
        };
        sent.google.push({
          url,
          key: new Headers(init?.headers).get('x-goog-api-key'),
          body: body as unknown as Record<string, unknown>,
        });
        if (!opts.google) throw new Error(`unexpected fetch ${url}`);
        return opts.google(body.contents[0]!.parts[0]!.text);
      }
      if (url.endsWith('/audio/speech')) {
        const req = JSON.parse(init?.body as string) as Record<string, unknown>;
        sent.speech.push(req);
        if (opts.speech) return opts.speech(String(req['input']), sent.speech.length - 1);
        return new Response(VOICE_PCM, {
          status: 200,
          headers: { 'content-type': 'audio/pcm' },
        });
      }
      // #976 — the ear: OpenRouter's transcription endpoint.
      if (url.endsWith('/audio/transcriptions')) {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        sent.transcription.push({ url, body });
        const audio = (body['input_audio'] as { data: string }).data;
        const t =
          typeof opts.transcription === 'function'
            ? opts.transcription(audio)
            : (opts.transcription ?? { status: 200, body: { text: TRANSCRIPT } });
        return new Response(JSON.stringify(t.body), {
          status: t.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as ChatBody & { model: string };
      const system = systemOf(body);
      const last = textOf(body.messages[body.messages.length - 1]?.content);
      const isFront = (body.tools ?? []).some((t) => t.function.name === 'run_task');
      let text = 'ok';
      let parts: string[] | null = null;
      let toolCall: { name: string; args: Record<string, unknown> } | null = null;
      if (system.startsWith(TITLE_SYSTEM_PROMPT.slice(0, 40))) text = 'Tokyo time';
      else if (system.includes('\n## Announcement\n')) {
        sent.announcement.push(body);
        if (opts.announcement?.status && opts.announcement.status !== 200) {
          return new Response(JSON.stringify({ error: { message: 'upstream refused' } }), {
            status: opts.announcement.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        text = opts.announcement?.text ?? 'It is done.';
      } else if (last.endsWith(ACTION_RECHECK)) {
        sent.log.push('recheck:start');
        if (opts.recheck?.hold) await opts.recheck.hold;
        text = 'ok';
        if (opts.recheck?.instruction !== undefined) {
          text = '';
          toolCall = { name: 'run_task', args: { instruction: opts.recheck.instruction } };
        }
      } else if (isFront) {
        sent.front.push(body);
        const front = opts.front ?? {};
        text = front.text ?? front.parts?.join('') ?? '';
        if (front.parts) parts = front.parts;
        if (front.instruction !== undefined) {
          toolCall = { name: 'run_task', args: { instruction: front.instruction } };
        }
      } else {
        sent.worker.push(body);
        const next = workerCalls.shift();
        if (next) {
          text = '';
          toolCall = next;
        } else text = opts.workerReply ?? 'Done.';
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
        const deltas: Array<Record<string, unknown>> = (parts ?? [text]).map((content, i) => ({
          ...(i === 0 ? { role: 'assistant' } : {}),
          ...(content ? { content } : {}),
        }));
        if (calls) deltas.push({ tool_calls: calls.map((c, index) => ({ index, ...c })) });
        const chunks = [
          ...deltas.map((delta) => ({ id: 'c', choices: [{ index: 0, delta }] })),
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const front = isFront ? opts.front : undefined;
        const enc = new TextEncoder();
        const sse = new ReadableStream<Uint8Array>({
          start(controller) {
            // Stop (#456) coupe l'appel : le fournisseur cesse d'écrire.
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(new DOMException('aborted', 'AbortError'));
              } catch {
                // already closed
              }
            });
            void (async () => {
              for (const [i, c] of chunks.entries()) {
                if (front?.hold && i === front.holdBefore) await front.hold;
                if (init?.signal?.aborted) return;
                controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
              }
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              if (isFront) sent.log.push('front:end');
              controller.close();
            })();
          },
        });
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const message: Record<string, unknown> = { role: 'assistant', content: text };
      if (calls) message['tool_calls'] = calls;
      if (isFront) sent.log.push('front:end');
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

type VoiceEvent = { event: string; data: Record<string, unknown> };

/** The events of the end's stream, as they arrive. */
async function* events(res: Response): AsyncGenerator<VoiceEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      yield { event, data: JSON.parse(data) as Record<string, unknown> };
      sep = buffer.indexOf('\n\n');
    }
  }
}

/** Read events until `stop` says so, within 4 s; the iterator stays open for the rest. */
async function readUntil(
  it: AsyncGenerator<VoiceEvent>,
  stop: (e: VoiceEvent) => boolean,
  into: VoiceEvent[],
): Promise<void> {
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`no event matched; got ${JSON.stringify(into.map((e) => e.event))}`)),
          4000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (next.done) throw new Error('the stream ended before the awaited event');
    into.push(next.value);
    if (stop(next.value)) return;
  }
}

/** Every remaining event of the stream. */
async function drain(it: AsyncGenerator<VoiceEvent>, into: VoiceEvent[]): Promise<void> {
  for (;;) {
    const next = await it.next();
    if (next.done) return;
    into.push(next.value);
  }
}

/** The PCM of every `audio` event, in the order they came, joined. */
function heardAudio(evs: VoiceEvent[]): Buffer {
  return Buffer.concat(
    evs
      .filter((e) => e.event === 'audio')
      .map((e) => Buffer.from(String(e.data['base64']), 'base64')),
  );
}

/** start and the audio in chunks, as a client sends them; returns the turn id. */
async function speak(
  app: ReturnType<typeof createApp>,
  conversationId: string,
  audio: Uint8Array,
  format: { format: 'audio/wav' } | { format: 'audio/pcm'; sampleRate: number },
  chunks = 3,
): Promise<string> {
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
  return turnId;
}

/**
 * The `say` gesture as a client makes it: start, the audio in chunks, end.
 * A refusal is its JSON; a stream is read to its end and summed up as the
 * turn it told: `transcript`, then `done`, with every event kept.
 */
async function say(
  app: ReturnType<typeof createApp>,
  conversationId: string,
  audio: Uint8Array,
  format: { format: 'audio/wav' } | { format: 'audio/pcm'; sampleRate: number },
  chunks = 3,
): Promise<{ status: number; body: Record<string, unknown>; events: VoiceEvent[] }> {
  const turnId = await speak(app, conversationId, audio, format, chunks);
  const end = await call(app, 'POST', `/api/voice/turns/${turnId}/end`);
  if (!(end.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { status: end.status, body: (await end.json()) as Record<string, unknown>, events: [] };
  }
  const evs: VoiceEvent[] = [];
  await drain(events(end), evs);
  const nothing = evs.find((e) => e.event === 'nothing_heard');
  if (nothing) {
    return { status: end.status, body: { outcome: 'nothing_heard', ...nothing.data }, events: evs };
  }
  const transcript = evs.find((e) => e.event === 'transcript')?.data ?? {};
  const done = evs.find((e) => e.event === 'done')?.data ?? {};
  return {
    status: end.status,
    body: { outcome: 'replied', ...transcript, ...done },
    events: evs,
  };
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

    const { status, body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: 'replied',
      transcript: TRANSCRIPT,
      durationMs: FIXTURE_MS,
      reply: 'It is nine in the evening in Tokyo.',
      spawnedJobId: null,
      streamed: true,
      stopped: false,
      speechError: null,
    });
    // The protocol, in order: the transcript, the reply's text (the stream
    // redactor holds the last word until the text is complete), its voice,
    // the end of that sentence's audio, done.
    expect(evs.map((e) => e.event)).toEqual([
      'transcript',
      'delta',
      'delta',
      'audio',
      'audio_end',
      'done',
    ]);
    expect(evs.find((e) => e.event === 'audio_end')?.data).toEqual({ sentence: 0, complete: true });
    // The bytes the client sent, in order, are what the transcriber received.
    // #976: through the transcription endpoint, with the stored model.
    expect(sent.transcription).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/transcriptions',
        body: {
          model: 'x-ai/grok-stt-1.0',
          input_audio: { data: Buffer.from(FIXTURE).toString('base64'), format: 'wav' },
        },
      },
    ]);
    // The voice read the agent's words, and the client got the PCM it said,
    // streamed, with the rate it plays at.
    expect(sent.speech).toHaveLength(1);
    expect(sent.speech[0]).toMatchObject({
      input: 'It is nine in the evening in Tokyo.',
      voice: 'Kore',
    });
    const audio = evs.find((e) => e.event === 'audio')!.data;
    expect(audio).toMatchObject({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 24_000 });
    expect(heardAudio(evs)).toEqual(Buffer.from(VOICE_PCM));
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
    expect(sent.transcription[0]!.body['input_audio']).toEqual({
      data: Buffer.from(pcmToWav(FIXTURE_PCM, { sampleRate: 16_000 })).toString('base64'),
      format: 'wav',
    });
    expect((await rows(conv))[0]).toEqual({
      role: 'user',
      content: TRANSCRIPT,
      spokenMs: FIXTURE_MS,
    });
  });

  // #967 — the job's result is read: its prompt no longer says "your reply is
  // heard". What is heard is its announcement (see the #967 describe below).
  it('a task request: run_task launches a job that inherits the spoken rendering; its own prompt writes to be read', async () => {
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
    expect(job!.systemPrompt).not.toContain(SPOKEN_LINE);
    // The worker's request, as the provider received it, carries no "heard" fact.
    expect(sent.worker.length).toBeGreaterThan(0);
    expect(systemOf(sent.worker[0]!)).not.toContain('- rendering:');
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
    expect(body).toEqual({ outcome: 'nothing_heard', durationMs: 0, model: null });
    expect(sent.transcription).toEqual([]);
    expect(sent.front).toEqual([]);
    expect(await rows(conv)).toEqual([]);
  });

  it('nothing heard: audio with no words in it stores nothing and starts no turn', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({
      transcription: { status: 200, body: { text: '' } },
    });

    const { status, body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(status).toBe(200);
    expect(body).toEqual({
      outcome: 'nothing_heard',
      durationMs: FIXTURE_MS,
      // #976: the model that wrote nothing, for the screen to name.
      model: 'x-ai/grok-stt-1.0',
    });
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
      detail: 'openrouter x-ai/grok-stt-1.0: HTTP 402 — Insufficient credits',
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
    expect(await res.json()).toEqual({ error: 'voice_key_missing', source: 'openrouter' });
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

// #943 — the reply spoken sentence by sentence, over the end's event stream.
//
// Mutations verified (each turns at least one case below red):
//   - speech waits for the whole text (`say` in run-voice-turn.ts only called
//     from `settle`, never from `onTextDelta`) → "before the model has
//     finished writing";
//   - chunks emitted out of order (voice-speech.ts emitting each job's chunks
//     as soon as they arrive instead of the head's) → "in the order of the
//     sentences";
//   - the recheck runs before the speech (`onReplyText` called after
//     `relireUneFois` in run-chat-turn.ts) → "does not hold back the first
//     speech event";
//   - the voice not cancelled on `stopped` → "Stop mid-stream".
describe('the voice turn route — the reply spoken as it is written (#943) @cap:parler-a-un-agent/moteur', () => {
  async function openEnd(
    app: ReturnType<typeof createApp>,
    conv: string,
  ): Promise<{ it: AsyncGenerator<VoiceEvent>; res: Response }> {
    const turnId = await speak(app, conv, FIXTURE, { format: 'audio/wav' });
    const res = await call(app, 'POST', `/api/voice/turns/${turnId}/end`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    return { it: events(res), res };
  }

  it('the first speech event is written before the model has finished writing', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const held = gate();
    const sent = network({
      front: {
        // The word after the full stop must be complete (a space after it)
        // for the boundary to show: the redactor holds a word until then.
        parts: ['Sure. The ', 'rest of the answer follows here.'],
        holdBefore: 1,
        hold: held.wait,
      },
    });

    const { it } = await openEnd(app, conv);
    const evs: VoiceEvent[] = [];
    await readUntil(it, (e) => e.event === 'audio', evs);
    // The model is still writing: its stream is held open, and the first
    // sentence is already heard.
    expect(sent.log).not.toContain('front:end');
    expect(sent.speech.map((s) => s['input'])).toEqual(['Sure.']);
    expect(evs.map((e) => e.event)).toEqual(['transcript', 'delta', 'audio']);
    expect(evs[1]!.data).toEqual({ text: 'Sure. The ' });
    expect(evs[0]!.data).toEqual({ transcript: TRANSCRIPT, durationMs: FIXTURE_MS });

    held.open();
    await drain(it, evs);
    expect(sent.speech.map((s) => s['input'])).toEqual([
      'Sure.',
      'The rest of the answer follows here.',
    ]);
    const audio = evs.filter((e) => e.event === 'audio').map((e) => e.data['seq']);
    expect(audio).toEqual(audio.map((_, i) => i));
    expect(evs.at(-1)).toEqual({
      event: 'done',
      data: {
        reply: 'Sure. The rest of the answer follows here.',
        spawnedJobId: null,
        streamed: true,
        stopped: false,
        cutReason: null,
        speechError: null,
      },
    });
    expect(heardAudio(evs)).toEqual(
      Buffer.concat([Buffer.from(VOICE_PCM), Buffer.from(VOICE_PCM)]),
    );
  });

  it('chunks come out in the order of the sentences, even when a later one is ready first, two at a time', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    let inFlight = 0;
    let most = 0;
    network({
      front: { parts: ['One is first. Two is second. Three is third.'] },
      speech: async (input) => {
        inFlight++;
        most = Math.max(most, inFlight);
        const n = input.startsWith('One') ? 1 : input.startsWith('Two') ? 2 : 3;
        // The first sentence is the SLOWEST to synthesize.
        await new Promise((r) => setTimeout(r, n === 1 ? 120 : 5));
        inFlight--;
        return new Response(Uint8Array.from([n, 0, n, 0]), {
          status: 200,
          headers: { 'content-type': 'audio/pcm' },
        });
      },
    });

    const { body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(body['reply']).toBe('One is first. Two is second. Three is third.');
    expect([...heardAudio(evs)]).toEqual([1, 0, 1, 0, 2, 0, 2, 0, 3, 0, 3, 0]);
    expect(evs.filter((e) => e.event === 'audio').map((e) => e.data['seq'])).toEqual([0, 1, 2]);
    expect(most).toBe(2);
  });

  it('the recheck runs after the text, while the speech plays: it does not hold back the first speech event', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const recheck = gate();
    const sent = network({ front: { parts: ['Sure thing.'] }, recheck: { hold: recheck.wait } });

    const { it } = await openEnd(app, conv);
    const evs: VoiceEvent[] = [];
    await readUntil(it, (e) => e.event === 'audio', evs);
    // The text is complete, and the recheck — held until `recheck.open()` —
    // has not answered: the voice did not wait for it. It does run, after.
    expect(sent.log[0]).toBe('front:end');
    for (let i = 0; i < 100 && !sent.log.includes('recheck:start'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sent.log).toEqual(['front:end', 'recheck:start']);
    expect(evs.some((e) => e.event === 'done')).toBe(false);

    recheck.open();
    await drain(it, evs);
    expect(evs.at(-1)?.data).toMatchObject({ reply: 'Sure thing.', spawnedJobId: null });
    expect(await rows(conv)).toEqual([
      { role: 'user', content: TRANSCRIPT, spokenMs: FIXTURE_MS },
      { role: 'assistant', content: 'Sure thing.', spokenMs: null },
    ]);
  });

  it('the final event carries the job the recheck launched', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({
      front: { parts: ['I will check the weather.'] },
      recheck: { instruction: '' },
    });

    const { body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    const jobId = body['spawnedJobId'];
    expect(typeof jobId).toBe('string');
    expect(sent.speech.map((s) => s['input'])).toEqual(['I will check the weather.']);
    await settled(jobId as string);
    const [job] = await jobsOf(conv);
    expect(job).toMatchObject({ id: jobId, task: TRANSCRIPT, replyRendering: 'spoken' });
  });

  // Review of #968, pass 2 (P2-B). Mutation verified: `audio_end` dropped on
  // the error path → red.
  it('a vendor that fails MID-SENTENCE: that sentence ends cut (`audio_end` complete false) before `done`', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    network({
      front: { parts: ['First part is fine. Second part is cut.'] },
      speech: (input) => {
        // The second sentence: its first bytes, then the vendor drops.
        const cut = input.startsWith('Second');
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(Uint8Array.from([cut ? 9 : 7, 0]));
            if (cut) setTimeout(() => c.error(new Error('vendor dropped the stream')), 10);
            else c.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
        });
      },
    });

    const { body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(
      evs
        .filter((e) => e.event === 'audio' || e.event === 'audio_end' || e.event === 'done')
        .map((e) =>
          e.event === 'audio'
            ? `audio ${String(e.data['sentence'])}`
            : e.event === 'audio_end'
              ? `end ${String(e.data['sentence'])} ${e.data['complete'] ? 'complete' : 'cut'}`
              : 'done',
        ),
    ).toEqual(['audio 0', 'end 0 complete', 'audio 1', 'end 1 cut', 'done']);
    expect(body['speechError']).toMatchObject({ detail: 'vendor dropped the stream' });
    expect(body['reply']).toBe('First part is fine. Second part is cut.');
  });

  it('a speech failure mid-stream keeps the text, states the failure, and says nothing after it', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    network({
      front: { parts: ['First part is fine. Second part fails. Third never plays.'] },
      speech: (input) =>
        input.startsWith('Second')
          ? new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
              status: 402,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(Uint8Array.from([7, 0]), {
              status: 200,
              headers: { 'content-type': 'audio/pcm' },
            }),
    });

    const { body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(body).toMatchObject({
      reply: 'First part is fine. Second part fails. Third never plays.',
      speechError: {
        // #969: a 402 is said as the key without credit it is.
        code: 'speech_no_credit',
        detail: 'openrouter google/gemini-3.8-flash-tts: HTTP 402 — Insufficient credits',
      },
    });
    // Only the first sentence was heard: nothing after the failed one.
    expect([...heardAudio(evs)]).toEqual([7, 0]);
    expect((await rows(conv))[1]).toEqual({
      role: 'assistant',
      content: 'First part is fine. Second part fails. Third never plays.',
      spokenMs: null,
    });
  });

  it('Stop mid-stream ends the turn, stores what the typed Stop stores, and the voice falls silent', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const held = gate();
    network({
      front: {
        parts: ['First sentence here. Then more ', 'words that never come.'],
        holdBefore: 1,
        hold: held.wait,
      },
    });

    const { it } = await openEnd(app, conv);
    const evs: VoiceEvent[] = [];
    await readUntil(it, (e) => e.event === 'audio', evs);
    const stop = await call(app, 'POST', '/api/chat/stop', {
      entityId: seed.entityId,
      conversationId: conv,
    });
    expect(await stop.json()).toEqual({ stopped: true });
    await drain(it, evs);
    held.open();

    expect(evs.at(-1)).toEqual({
      event: 'done',
      data: {
        reply: 'First sentence here. Then more',
        spawnedJobId: null,
        streamed: true,
        stopped: true,
        cutReason: null,
        speechError: null,
      },
    });
    expect(evs.filter((e) => e.event === 'audio')).toHaveLength(1);
    const stored = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        stopped: chatMessages.stopped,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv))
      .orderBy(asc(chatMessages.createdAt));
    expect(stored).toEqual([
      { role: 'user', content: TRANSCRIPT, stopped: false },
      { role: 'assistant', content: 'First sentence here. Then more', stopped: true },
    ]);
  });

  // Mutations verified: the vendor's `complete` marked at its first byte →
  // red (the gap is gone); the rate taken from anywhere but the answer → red.
  it('one timing line per turn, numbers only, never the words: the vendor’s first byte apart from its whole body', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    let evs: VoiceEvent[] = [];
    try {
      const app = createApp(makeDeps(), testEnv);
      const conv = await conversation();
      network({
        front: { parts: ['Nine in the evening.'] },
        // A vendor that streams: its first bytes, then the rest 80 ms later,
        // at the rate IT names.
        speech: () => {
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(Uint8Array.from([1, 0]));
              setTimeout(() => {
                c.enqueue(Uint8Array.from([2, 0]));
                c.close();
              }, 80);
            },
          });
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'audio/pcm;rate=44100;channels=1' },
          });
        },
      });
      ({ events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' }));
      await say(app, conv, new Uint8Array(0), { format: 'audio/pcm', sampleRate: 16_000 });
    } finally {
      warn.mockRestore();
    }
    expect(
      evs.filter((e) => e.event === 'audio').map((e) => [e.data['seq'], e.data['sampleRate']]),
    ).toEqual([
      [0, 44_100],
      [1, 44_100],
    ]);
    const timing = lines.filter((l) => l.startsWith('[voice-turn] timing '));
    expect(timing).toHaveLength(2);
    // #969: the line names the voice that spoke — identifiers only.
    expect(timing[0]).toMatch(
      /^\[voice-turn\] timing \{"source":"openrouter","model":"google\/gemini-3\.8-flash-tts","voice":"Kore","transcriptionModel":"x-ai\/grok-stt-1\.0","transcriptMs":\d+,"firstDeltaMs":\d+,"firstSentenceMs":\d+,"firstSentenceVendorByteMs":\d+,"firstSentenceVendorDoneMs":\d+,"firstAudioMs":\d+,"doneMs":\d+\}$/,
    );
    expect(timing[1]).toMatch(
      /^\[voice-turn\] timing \{"source":null,"model":null,"voice":null,"transcriptionModel":null,"transcriptMs":null,"firstDeltaMs":null,"firstSentenceMs":null,"firstSentenceVendorByteMs":null,"firstSentenceVendorDoneMs":null,"firstAudioMs":null,"doneMs":\d+\}$/,
    );
    const marks = JSON.parse(timing[0]!.slice('[voice-turn] timing '.length)) as Record<
      string,
      number
    >;
    expect(marks['transcriptMs']!).toBeLessThanOrEqual(marks['firstDeltaMs']!);
    expect(marks['firstSentenceMs']!).toBeLessThanOrEqual(marks['firstSentenceVendorByteMs']!);
    // The vendor streamed: its whole body came well after its first byte.
    expect(
      marks['firstSentenceVendorDoneMs']! - marks['firstSentenceVendorByteMs']!,
    ).toBeGreaterThanOrEqual(60);
    expect(marks['firstSentenceVendorByteMs']!).toBeLessThanOrEqual(marks['firstAudioMs']!);
    expect(marks['firstAudioMs']!).toBeLessThanOrEqual(marks['doneMs']!);
    for (const l of timing) expect(l).not.toContain('Nine');
  });

  // Review of #968, pass 2 (P2-A): the deltas are masked ONCE, in
  // `playChatTurn`, upstream of every consumer — the live relay included.
  // Mutation verified: the redaction moved back below `say()` (the live relay
  // fed raw deltas) → both cases below are red; the voice still masked.
  describe('a secret read from /api/chat/live during the turn', () => {
    const KEY = 'sk-or-v1-abcdefghijklmnopqrstu';
    const MASKED = `Your key is ${REDACTED_TEXT} (sk-). Keep it safe.`;

    /** start.text, then every delta, until `end`: what a live reader saw. */
    async function readLive(res: Response): Promise<string> {
      expect(res.status).toBe(200);
      let text = '';
      for await (const e of events(res)) {
        if (e.event === 'start') text += String(e.data['text']);
        if (e.event === 'delta') text += String(e.data['text']);
        if (e.event === 'end') break;
      }
      return text;
    }

    function heldKeyNetwork(held: Promise<void>) {
      // The key arrives split across two deltas; the second waits for the gate.
      return network({
        front: {
          parts: ['Your key is sk-or-v1-abcdefgh', 'ijklmnopqrstu. Keep it safe.'],
          holdBefore: 1,
          hold: held,
        },
      });
    }

    async function storedReply(conv: string): Promise<string> {
      return (await rows(conv)).find((r) => r.role === 'assistant')?.content ?? '';
    }

    it('during a voice turn: masked for the live reader, for the voice, and stored intact', async () => {
      const app = createApp(makeDeps(), testEnv);
      const conv = await conversation();
      const g = gate();
      const sent = heldKeyNetwork(g.wait);

      const { it: voice } = await openEnd(app, conv);
      const evs: VoiceEvent[] = [];
      await readUntil(voice, (e) => e.event === 'delta', evs);
      const live = call(app, 'POST', '/api/chat/live', {
        entityId: seed.entityId,
        conversationId: conv,
      });
      const liveRes = await live;
      g.open();
      const [liveText] = await Promise.all([readLive(liveRes), drain(voice, evs)]);

      expect(liveText).toBe(MASKED);
      expect(liveText).not.toContain('abcdefgh');
      expect(sent.speech.map((r) => r['input'])).toEqual([
        `Your key is ${REDACTED_TEXT} (sk-).`,
        'Keep it safe.',
      ]);
      expect(await storedReply(conv)).toBe(`Your key is ${KEY}. Keep it safe.`);
    });

    it('during a typed turn: masked for the live reader and the typed stream, stored intact', async () => {
      const app = createApp(makeDeps(), testEnv);
      const conv = await conversation();
      const g = gate();
      heldKeyNetwork(g.wait);

      const typed = await call(app, 'POST', '/api/chat/stream', {
        entityId: seed.entityId,
        agentId,
        conversationId: conv,
        message: 'What is my key?',
      });
      const typedIt = events(typed);
      const typedEvs: VoiceEvent[] = [];
      await readUntil(typedIt, (e) => e.event === 'delta', typedEvs);
      const liveRes = await call(app, 'POST', '/api/chat/live', {
        entityId: seed.entityId,
        conversationId: conv,
      });
      g.open();
      const [liveText] = await Promise.all([readLive(liveRes), drain(typedIt, typedEvs)]);

      expect(liveText).toBe(MASKED);
      const typedDeltas = typedEvs
        .filter((e) => e.event === 'delta')
        .map((e) => String(e.data['text']))
        .join('');
      expect(typedDeltas).toBe(MASKED);
      expect(await storedReply(conv)).toBe(`Your key is ${KEY}. Keep it safe.`);
    });
  });

  // Review of #968, pass 1 (P2-1). Mutations verified: the runner's redaction
  // removed → red on every assertion below but the stored row; the text
  // masked AFTER the chunker (raw deltas to the voice, masked to the screen)
  // → red on what the voice received.
  it('a secret in the reply is masked on every way out — the text, done, and what the voice SAYS — and stored intact', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const key = 'sk-or-v1-abcdefghijklmnopqrstu';
    // The key arrives split across two deltas: no fragment holds it whole.
    const sent = network({
      front: { parts: ['Your key is sk-or-v1-abcdefgh', 'ijklmnopqrstu. Keep it safe.'] },
    });

    const { body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    const masked = `Your key is ${REDACTED_TEXT} (sk-). Keep it safe.`;
    const deltas = evs
      .filter((e) => e.event === 'delta')
      .map((e) => String(e.data['text']))
      .join('');
    expect(deltas).toBe(masked);
    expect(body['reply']).toBe(masked);
    // What the speech vendor was asked to SAY.
    expect(sent.speech.map((r) => r['input'])).toEqual([
      `Your key is ${REDACTED_TEXT} (sk-).`,
      'Keep it safe.',
    ]);
    for (const e of evs) expect(JSON.stringify(e.data)).not.toContain('abcdefgh');
    // The stored row keeps what the agent wrote: masking is for display.
    expect((await rows(conv))[1]).toEqual({
      role: 'assistant',
      content: `Your key is ${key}. Keep it safe.`,
      spokenMs: null,
    });
  });
});

// ── #969 — the voice Nodal speaks with is the workspace's setting ────────────

/** Google's `streamGenerateContent?alt=sse`: one event per PCM chunk, as measured on 2026-11-03. */
function googleSse(chunks: number[][]): Response {
  const events = chunks.map(
    (bytes) =>
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/l16; rate=24000; channels=1',
                    data: Buffer.from(bytes).toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      })}\r\n\r\n`,
  );
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const FIRST_VOICE = {
  source: 'openrouter',
  model: 'google/gemini-3.8-flash-tts',
  voice: 'Kore',
  transcriptionModel: 'x-ai/grok-stt-1.0',
} as const;

describe('the voice turn speaks with the workspace voice (#969) @cap:parler-a-un-agent/moteur', () => {
  afterEach(async () => {
    clearVoiceCatalog();
    await writeVoiceSetting(db as never, seed.entityId, FIRST_VOICE);
    await db
      .delete(entityLlmKeys)
      .where(and(eq(entityLlmKeys.entityId, seed.entityId), eq(entityLlmKeys.provider, 'google')));
  });

  async function googleKey(): Promise<void> {
    await db.insert(entityLlmKeys).values({
      entityId: seed.entityId,
      provider: 'google',
      apiKey: encrypt('AIza-test'),
      isActive: true,
    });
  }

  // Mutations verified: the turn speaking with the first value instead of the
  // resolved one → red; the setting read once per process (kept in memory)
  // → red at the second turn.
  it('speaks with the stored source, model and voice, and a change made by the route applies to the next turn, no restart', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    await googleKey();
    const sent = network({
      front: { text: 'Nine in the evening.' },
      google: () =>
        googleSse([
          [1, 2, 3, 4],
          [5, 6],
        ]),
    });

    const grok = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(grok.status).toBe(200);
    // A voice that spoke is stored.
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    const first = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    expect(first.body['speechError']).toBeNull();
    // The save first made the voice say its probe (#972, pass 1), then the turn spoke.
    expect(sent.speech).toEqual([
      { model: 'x-ai/grok-voice-tts-1.0', input: 'OK.', voice: 'leo', response_format: 'pcm' },
      {
        model: 'x-ai/grok-voice-tts-1.0',
        input: 'Nine in the evening.',
        voice: 'leo',
        response_format: 'pcm',
      },
    ]);
    expect(sent.google).toEqual([]);

    const gemini = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'google',
        model: 'gemini-3.8-flash-tts',
        voice: 'Puck',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(gemini.status).toBe(200);
    const second = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    expect(second.body['speechError']).toBeNull();
    expect(sent.speech).toHaveLength(2);
    const geminiRequest = (text: string) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent?alt=sse',
      key: 'AIza-test',
      body: {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
      },
    });
    expect(sent.google).toEqual([geminiRequest('OK.'), geminiRequest('Nine in the evening.')]);
    // Google's events, in order, as little-endian PCM at the rate they name.
    const audio = second.events.filter((e) => e.event === 'audio');
    expect(audio.map((e) => [e.data['seq'], e.data['mimeType'], e.data['sampleRate']])).toEqual([
      [0, 'audio/pcm', 24_000],
      [1, 'audio/pcm', 24_000],
    ]);
    expect([...heardAudio(second.events)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // MiniMax answers mp3 only (measured 2026-11-03). Mutation verified: the
  // chunk's container replaced by the adapter's `streamOutput` in
  // voice-speech.ts → red (the mp3 goes out labelled pcm).
  it('a model that answers mp3 speaks mp3: each chunk carries its container, and every sentence ends complete', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    await writeVoiceSetting(db as never, seed.entityId, {
      source: 'openrouter',
      model: 'minimax/speech-2.8-turbo',
      voice: 'English_CalmWoman',
      transcriptionModel: 'x-ai/grok-stt-1.0',
    });
    const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00]);
    const sent = network({
      front: { text: 'Nine in the evening. Then rain.' },
      speech: () => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    });

    const { body, events: evs } = await say(app, conv, FIXTURE, { format: 'audio/wav' });

    expect(body['speechError']).toBeNull();
    expect(sent.speech.map((s) => [s['model'], s['voice']])).toEqual([
      ['minimax/speech-2.8-turbo', 'English_CalmWoman'],
      ['minimax/speech-2.8-turbo', 'English_CalmWoman'],
    ]);
    const voiced = evs.filter((e) => e.event === 'audio' || e.event === 'audio_end');
    expect(
      voiced.map((e) =>
        e.event === 'audio'
          ? ['audio', e.data['sentence'], e.data['mimeType'], e.data['sampleRate'] ?? null]
          : ['audio_end', e.data['sentence'], e.data['complete']],
      ),
    ).toEqual([
      ['audio', 0, 'audio/mpeg', null],
      ['audio_end', 0, true],
      ['audio', 1, 'audio/mpeg', null],
      ['audio_end', 1, true],
    ]);
    expect([...heardAudio(evs)]).toEqual([...MP3, ...MP3]);
  });

  // Review of #972, pass 1 (P2). Listed is not enough: OpenRouter lists MiniMax
  // with its voices and answers 400 to its synthesis (measured 2026-11-03).
  // Mutation verified: the probe skipped (`probeRefusal` not called) → red,
  // the refused voice is stored.
  it('a listed voice that does not speak through the turn path is refused at Save with the vendor words; the row is unchanged', async () => {
    const app = createApp(makeDeps(), testEnv);
    const MINIMAX_400 = 'MiniMax TTS only supports response_format="mp3" for streaming. Got "pcm".';
    const sent = network({
      speech: () =>
        new Response(JSON.stringify({ error: { message: MINIMAX_400, code: 400 } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const res = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'openrouter',
        model: 'minimax/speech-2.8-turbo',
        voice: 'English_CalmWoman',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'speech_provider_error',
      source: 'openrouter',
      detail: `openrouter minimax/speech-2.8-turbo: HTTP 400 — ${MINIMAX_400}`,
    });
    // It was tried once, by the turn's path, with the probe.
    expect(sent.speech).toEqual([
      {
        model: 'minimax/speech-2.8-turbo',
        input: 'OK.',
        voice: 'English_CalmWoman',
        response_format: 'pcm',
      },
    ]);
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });
  });

  // Review of #972, pass 2 (P2): a vendor can echo the key it refused, and its
  // words are shown. Mutation verified: SpeechError built without masking →
  // red, the key reaches both the Save refusal and the turn's speechError.
  it('a vendor echoing the key it refused: masked in the Save refusal and in the turn', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const KEY = `sk-or-v1-${'a1b2c3d4e5'.repeat(4)}`;
    network({
      front: { text: 'Nine in the evening.' },
      speech: () =>
        new Response(
          JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, code: 401 } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    });
    const saved = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    const refusal = JSON.stringify(await saved.json());
    expect(saved.status).toBe(409);
    expect(refusal).not.toContain(KEY);
    expect(refusal).toContain('Incorrect API key provided: [secret masqué] (sk-)');

    const turn = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    expect(turn.body['speechError']).toEqual({
      code: 'speech_provider_error',
      detail:
        'openrouter google/gemini-3.8-flash-tts: HTTP 401 — Incorrect API key provided: [secret masqué] (sk-)',
    });
    expect(JSON.stringify(turn.events)).not.toContain(KEY);
  });

  it('a voice the model does not offer is refused with a stated error, and the voice in force does not change', async () => {
    const app = createApp(makeDeps(), testEnv);
    network({});
    const refused = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'Kore',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'voice_not_offered',
      source: 'openrouter',
      detail: 'x-ai/grok-voice-tts-1.0 offers eve, ara, rex, sal, leo',
    });
    const unknown = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: {
        source: 'openrouter',
        model: 'nobody/tts',
        voice: 'leo',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(unknown.status).toBe(409);
    expect(((await unknown.json()) as { error: string }).error).toBe('voice_model_not_offered');
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });
  });

  it('a missing Google key and an out-of-credit answer (402) are said as such; the reply stays written', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    await writeVoiceSetting(db as never, seed.entityId, {
      source: 'google',
      model: 'gemini-3.8-flash-tts',
      voice: 'Kore',
      transcriptionModel: 'x-ai/grok-stt-1.0',
    });
    network({
      front: { text: 'Nine in the evening.' },
      google: () =>
        new Response(
          JSON.stringify([
            { error: { code: 402, message: 'Your prepayment credits are depleted.' } },
          ]),
          { status: 402 },
        ),
    });

    const noKey = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    expect(noKey.body['reply']).toBe('Nine in the evening.');
    expect(noKey.body['speechError']).toEqual({ code: 'voice_key_missing', detail: 'google' });
    expect(noKey.events.some((e) => e.event === 'audio')).toBe(false);

    await googleKey();
    const noCredit = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    expect(noCredit.body['reply']).toBe('Nine in the evening.');
    expect(noCredit.body['speechError']).toEqual({
      code: 'speech_no_credit',
      detail: 'google gemini-3.8-flash-tts: HTTP 402 — Your prepayment credits are depleted.',
    });
  });

  it('reads the setting and what each source offers; a source without key says so', async () => {
    const app = createApp(makeDeps(), testEnv);
    network({});
    const res = await call(app, 'GET', `/api/voice/setting?entityId=${seed.entityId}`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      setting: unknown;
      sources: Array<{ source: string; state: string; code?: string; models?: unknown[] }>;
    };
    expect(state.setting).toEqual(FIRST_VOICE);
    expect(state.sources.map((s) => [s.source, s.state, s.code ?? s.models?.length])).toEqual([
      ['openrouter', 'available', 3],
      ['google', 'unavailable', 'voice_key_missing'],
    ]);
  });

  // Mutation verified: the sample ignoring the voice on screen (no `setting`
  // passed to `openReplyVoice`) → red.
  it('Play a sample speaks the caller sentence through the turn path: the stored voice, or the one on screen', async () => {
    const app = createApp(makeDeps(), testEnv);
    const sent = network({});
    const stored = await call(app, 'POST', '/api/voice/sample', {
      entityId: seed.entityId,
      text: 'This is how I sound.',
    });
    expect(stored.headers.get('content-type')).toContain('text/event-stream');
    const evs: VoiceEvent[] = [];
    await drain(events(stored), evs);
    // The turn's own events, `audio_end` included (#968): the sample is the turn's path.
    expect(evs.map((e) => e.event)).toEqual(['audio', 'audio_end', 'done']);
    expect(evs[0]!.data).toMatchObject({ seq: 0, mimeType: 'audio/pcm', sampleRate: 24_000 });
    expect(evs[1]!.data).toEqual({ sentence: 0, complete: true });
    expect(evs[2]!.data).toEqual({
      speechError: null,
      source: 'openrouter',
      model: 'google/gemini-3.8-flash-tts',
      voice: 'Kore',
    });
    expect(sent.speech.map((s) => [s['model'], s['voice'], s['input']])).toEqual([
      ['google/gemini-3.8-flash-tts', 'Kore', 'This is how I sound.'],
    ]);

    const candidate = await call(app, 'POST', '/api/voice/sample', {
      entityId: seed.entityId,
      text: 'This is how I sound.',
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'eve',
      },
    });
    const cand: VoiceEvent[] = [];
    await drain(events(candidate), cand);
    expect(cand.at(-1)!.data).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'eve' });
    expect(sent.speech.at(-1)).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'eve' });
    // Trying a voice never stores it.
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });

    const refused = await call(app, 'POST', '/api/voice/sample', {
      entityId: seed.entityId,
      text: 'x',
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'Kore',
      },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('voice_not_offered');
  });
});

// ─── #967 — a voice-launched job announces its end, out loud ─────────────────
//
// The owner's rule (2026-11-04): a job launched by voice ends with TWO things,
// both the agent's: its RESULT, written for reading and unchanged everywhere,
// and a short ANNOUNCEMENT written for the ear, generated after the job by the
// same agent from the request and the result. What is proven, on the real
// runner (the real voice turn, the real job, the real gates, the real
// /api/events and /api/voice/replies routes; only the network is a stub): a
// voice job that finishes yields ONE `reply.audio`, right after its
// `job.finished`; the announcement request carries the agent's personality,
// the "heard" line and the quoted result; what is spoken is the announcement
// (never the result), stored on the row; the voice read from the pointer is
// the bytes the fake voice returned. Jobs that do not speak (typed,
// delegated, failed, stopped, empty) change nothing: their `job.finished` is
// the same object as before #967, no announcement is asked, no voice either.
//
// Mutations verified (each turns a case red): see the PR body, "Mutations".

describe('a voice-launched job announces its end, out loud (#967) @cap:parler-a-un-agent/moteur', () => {
  /** `/api/events`, read as it arrives; the reader stays open for the test. */
  async function listenEvents(
    app: ReturnType<typeof createApp>,
    conversationId?: string,
  ): Promise<{ events: VoiceEvent[]; close: () => void }> {
    const ctl = new AbortController();
    const query = new URLSearchParams({ entityId: seed.entityId });
    if (conversationId) query.set('conversationId', conversationId);
    const res = await app.fetch(
      new Request(`http://localhost/api/events?${query.toString()}`, {
        headers: AUTH,
        signal: ctl.signal,
      }),
    );
    expect(res.status).toBe(200);
    const evs: VoiceEvent[] = [];
    void (async () => {
      try {
        for await (const e of events(res)) evs.push(e);
      } catch {
        // closed by the test
      }
    })();
    await waitUntil(() => evs.some((e) => e.event === 'ready'));
    return { events: evs, close: () => ctl.abort() };
  }

  async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('waitUntil: condition never met');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Time for an event that should not come to come anyway. */
  const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

  const ofJob = (evs: VoiceEvent[], jobId: string): VoiceEvent[] =>
    evs.filter((e) => e.data['jobId'] === jobId);

  /** The voice the pointer leads to, read to its `done`. */
  async function readReply(
    app: ReturnType<typeof createApp>,
    audioId: string,
  ): Promise<{ status: number; events: VoiceEvent[]; body?: unknown }> {
    const res = await call(app, 'GET', `/api/voice/replies/${audioId}?entityId=${seed.entityId}`);
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return { status: res.status, events: [], body: await res.json() };
    }
    const evs: VoiceEvent[] = [];
    await drain(events(res), evs);
    return { status: res.status, events: evs };
  }

  /** A row the gates can finish, as a job of the conversation. */
  async function jobRow(opts: {
    conversationId: string;
    replyRendering: 'text' | 'spoken';
    parentJobId?: string;
  }): Promise<string> {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId,
        channel: 'dashboard',
        task: 'Search the web for the latest news about Microsoft layoffs.',
        status: 'processing',
        messages: [],
        chainCount: 0,
        conversationId: opts.conversationId,
        replyRendering: opts.replyRendering,
        ...(opts.parentJobId ? { parentJobId: opts.parentJobId, delegationDepth: 1 } : {}),
      })
      .returning({ id: agentJobs.id });
    return job!.id;
  }

  const finish = (jobId: string, result: string) =>
    finalizeJobSuccess(db as never, {
      jobId,
      result,
      resultKind: 'prose',
      repairTurn: 'unsupported',
    });

  const rowOf = async (jobId: string) =>
    (
      await db
        .select({
          status: agentJobs.status,
          result: agentJobs.result,
          replyRendering: agentJobs.replyRendering,
          spokenAnnouncement: agentJobs.spokenAnnouncement,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId))
    )[0]!;

  /** A result made for reading: headings, a list, a URL. It is never read aloud. */
  const RESULT =
    '**Microsoft layoffs: latest news (as of 4 Nov 2026)**\n\n' +
    '1. Voluntary Exit Offer to about 60,000 employees (26 Oct 2026). ' +
    'Sources: NYT (https://www.nytimes.com/2026/10/26/technology/microsoft-buyouts-ai-spending.html)';
  const ANNOUNCEMENT = 'The research on Microsoft layoffs is ready. You can read it in Nodal.';

  it('a voice-launched job yields one announcement, after its job.finished: the result stays written, the announcement is said', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({
      front: { text: 'On it.', instruction: '' },
      workerReply: RESULT,
      announcement: { text: ANNOUNCEMENT },
    });

    const { body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    const jobId = body['spawnedJobId'] as string;
    await settled(jobId);

    await waitUntil(() => ofJob(stream.events, jobId).length >= 2);
    await quiet();
    const mine = ofJob(stream.events, jobId);
    expect(mine.map((e) => e.event)).toEqual(['job.finished', 'reply.audio']);
    // job.finished is the object it was before #967, to the key: the result.
    expect(mine[0]!.data).toEqual({
      type: 'job.finished',
      jobId,
      conversationId: conv,
      parentJobId: null,
      status: 'completed',
      reply: RESULT,
    });
    const audioId = mine[1]!.data['audioId'] as string;
    expect(mine[1]!.data).toEqual({ type: 'reply.audio', jobId, conversationId: conv, audioId });

    const voice = await readReply(app, audioId);
    expect(voice.status).toBe(200);

    // The announcement request, as the provider received it: the agent's own
    // personality, the fact that it is heard, the result quoted whole, and the
    // rule after it (the prompt itself: spoken-announcement.test.ts).
    expect(sent.announcement).toHaveLength(1);
    const system = systemOf(sent.announcement[0]!);
    expect(system.startsWith('You are a test agent.\n\n## Announcement\n')).toBe(true);
    expect(system).toContain('what you write is turned into speech and heard, not read.');
    const asked = textOf(sent.announcement[0]!.messages.at(-1)!.content);
    expect(asked.startsWith(`The person asked:\n${TRANSCRIPT}\n\n`)).toBe(true);
    expect(asked).toContain(`<<<\n${RESULT}\n>>>`);
    expect(asked).toContain(
      'Do not tell them what it says: no summary, no finding, no number, no name from it.',
    );
    expect(asked).toContain('and nothing else: there is no channel you can send it on.');
    // Its tokens are traced, on the job, under their own source.
    const traced = await db
      .select({ source: llmCalls.source })
      .from(llmCalls)
      .where(and(eq(llmCalls.jobId, jobId), eq(llmCalls.source, 'announcement')));
    expect(traced).toHaveLength(1);

    // What is SPOKEN: the acknowledgement, then the announcement, never the result.
    expect(sent.speech.map((s) => s['input'])).toEqual([
      'On it.',
      'The research on Microsoft layoffs is ready.',
      'You can read it in Nodal.',
    ]);
    expect(voice.events.map((e) => e.event)).toEqual([
      'audio',
      'audio_end',
      'audio',
      'audio_end',
      'done',
    ]);
    expect(heardAudio(voice.events)).toEqual(Buffer.concat([VOICE_PCM, VOICE_PCM]));
    expect(voice.events.filter((e) => e.event === 'audio').map((e) => e.data['seq'])).toEqual([
      0, 1,
    ]);
    expect(voice.events.at(-1)!.data).toEqual({ text: ANNOUNCEMENT, speechError: null });

    // The row: the result unchanged, the announcement beside it.
    expect(await rowOf(jobId)).toEqual({
      status: 'completed',
      result: RESULT,
      replyRendering: 'spoken',
      spokenAnnouncement: ANNOUNCEMENT,
    });

    // A second reader, late, gets the same voice from seq 0; nothing is asked again.
    const again = await readReply(app, audioId);
    expect(heardAudio(again.events)).toEqual(Buffer.concat([VOICE_PCM, VOICE_PCM]));
    expect(sent.speech).toHaveLength(3);
    expect(sent.announcement).toHaveLength(1);
    stream.close();
  });

  it('the announcement offers the channels where the person is reachable, read from the agent’s bindings', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({ announcement: { text: ANNOUNCEMENT } });
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId,
      channel: 'telegram',
      credentials: JSON.stringify({ botToken: 'fake' }),
      enabled: true,
    });
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId,
      chatId: 'owner-chat',
      role: 'owner',
      status: 'active',
    });
    try {
      const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
      await finish(job, RESULT);
      await waitUntil(() => ofJob(stream.events, job).length >= 2);
      await readReply(app, ofJob(stream.events, job)[1]!.data['audioId'] as string);
      expect(textOf(sent.announcement[0]!.messages.at(-1)!.content)).toContain(
        'and offer to send it to them on telegram. Two short sentences at most.',
      );
    } finally {
      await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, agentId));
      await db.delete(channelBindings).where(eq(channelBindings.agentId, agentId));
      stream.close();
    }
  });

  it('a typed-chat job yields none: its job.finished is unchanged, no announcement, no voice', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({ front: { text: 'Launching.', instruction: '' }, workerReply: RESULT });

    const res = await call(app, 'POST', '/api/chat', {
      entityId: seed.entityId,
      agentId,
      conversationId: conv,
      message: TRANSCRIPT,
    });
    expect(res.status).toBe(200);
    const [job] = await jobsOf(conv);
    await settled(job!.id);

    await waitUntil(() => ofJob(stream.events, job!.id).length >= 1);
    await quiet();
    expect(ofJob(stream.events, job!.id)).toEqual([
      {
        event: 'job.finished',
        data: {
          type: 'job.finished',
          jobId: job!.id,
          conversationId: conv,
          parentJobId: null,
          status: 'completed',
          reply: RESULT,
        },
      },
    ]);
    expect(stream.events.filter((e) => e.event === 'reply.audio')).toEqual([]);
    expect(sent.announcement).toEqual([]);
    expect(sent.speech).toEqual([]);
    expect((await rowOf(job!.id)).spokenAnnouncement).toBeNull();
    stream.close();
  });

  it('a delegated job yields none, even when it carries the spoken rendering', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({});
    const parent = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    const child = await jobRow({
      conversationId: conv,
      replyRendering: 'spoken',
      parentJobId: parent,
    });

    await finish(child, 'The full report, with its sources.');
    await waitUntil(() => ofJob(stream.events, child).length >= 1);
    await quiet();
    expect(ofJob(stream.events, child).map((e) => e.event)).toEqual(['job.finished']);
    expect(stream.events.filter((e) => e.event === 'reply.audio')).toEqual([]);
    expect(sent.announcement).toEqual([]);
    expect(sent.speech).toEqual([]);
    stream.close();
  });

  it('a spoken job that fails, is stopped, or ends with no result says nothing: the runner writes no words', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({});

    const failed = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finalizeJobFailure(db as never, {
      jobId: failed,
      errorCode: 'llm_error',
      userMessage: 'The model did not answer.',
    });
    // Stopped with half a result written: the person asked for the stop.
    const stopped = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await db.update(agentJobs).set({ result: 'Half of it.' }).where(eq(agentJobs.id, stopped));
    await inTransaction(db as never, (tx) => cancelJobs(tx as never, { ids: [stopped] }));
    const empty = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: '   ' })
      .where(eq(agentJobs.id, empty));
    // The gate the row skipped, called as it would be: what it publishes is what speaks.
    const finished = await publishJobEnded(db as never, empty);
    expect(finished).not.toBeNull();
    expect(speakFinishedJob(db as never, finished!)).toBeNull();

    await waitUntil(
      () =>
        ofJob(stream.events, failed).length >= 1 &&
        ofJob(stream.events, stopped).length >= 1 &&
        ofJob(stream.events, empty).length >= 1,
    );
    await quiet();
    expect(ofJob(stream.events, failed).map((e) => e.event)).toEqual(['job.failed']);
    expect(ofJob(stream.events, stopped).map((e) => e.event)).toEqual(['job.finished']);
    expect(ofJob(stream.events, stopped)[0]!.data['status']).toBe('cancelled');
    expect(ofJob(stream.events, empty).map((e) => e.event)).toEqual(['job.finished']);
    expect(stream.events.filter((e) => e.event === 'reply.audio')).toEqual([]);
    expect(sent.announcement).toEqual([]);
    expect(sent.speech).toEqual([]);
    stream.close();
  });

  it('nobody listening when the job finishes: nothing is written or synthesised, nothing is offered later', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const sent = network({});
    const warn = vi.spyOn(console, 'warn');
    const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finish(job, RESULT);
    await quiet();
    expect(sent.announcement).toEqual([]);
    expect(sent.speech).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      `[voice-job-reply] job ${job} ended with a spoken request and no listener: nothing said`,
    );
    warn.mockRestore();
    expect((await rowOf(job)).spokenAnnouncement).toBeNull();
    // A client that comes afterwards is offered nothing: no event, no voice.
    const late = await listenEvents(app, conv);
    await quiet();
    expect(late.events.filter((e) => e.event === 'reply.audio')).toEqual([]);
    late.close();
  });

  it('an announcement the model cannot write is said as such; nothing is spoken, the result stays', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const sent = network({ announcement: { status: 500 } });
    const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finish(job, RESULT);
    await waitUntil(() => ofJob(stream.events, job).length >= 2);
    const voice = await readReply(app, ofJob(stream.events, job)[1]!.data['audioId'] as string);
    expect(voice.events.map((e) => e.event)).toEqual(['done']);
    expect(voice.events[0]!.data).toMatchObject({
      text: null,
      speechError: { code: 'announcement_failed' },
    });
    expect(sent.speech).toEqual([]);
    expect(await rowOf(job)).toMatchObject({ result: RESULT, spokenAnnouncement: null });
    stream.close();
  });

  it('a secret in the announcement is masked in what the voice says; the row keeps it', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    const secret = `sk-or-v1-${'a'.repeat(64)}`;
    const sent = network({ announcement: { text: `Your key is ${secret} and it works.` } });
    const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finish(job, RESULT);
    await waitUntil(() => ofJob(stream.events, job).length >= 2);
    const voice = await readReply(app, ofJob(stream.events, job)[1]!.data['audioId'] as string);
    const said = sent.speech.map((s) => String(s['input'])).join(' ');
    expect(said).not.toContain(secret);
    expect(said).toContain(REDACTED_TEXT);
    expect(JSON.stringify(voice.events)).not.toContain(secret);
    expect((await rowOf(job)).spokenAnnouncement).toContain(secret);
    stream.close();
  });

  it('the voice is read in its own workspace only, and an unknown one is refused, never guessed', async () => {
    const app = createApp(makeDeps(), testEnv);
    const unknown = await readReply(app, randomUUID());
    expect(unknown).toMatchObject({ status: 404, body: { error: 'reply_audio_not_found' } });

    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    network({});
    const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finish(job, RESULT);
    await waitUntil(() => ofJob(stream.events, job).length >= 2);
    const audioId = ofJob(stream.events, job)[1]!.data['audioId'] as string;
    const res = await call(app, 'GET', `/api/voice/replies/${audioId}?entityId=${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'reply_audio_not_found' });
    const noEntity = await call(app, 'GET', `/api/voice/replies/${audioId}`);
    expect(noEntity.status).toBe(400);
    stream.close();
  });

  it('one timing line per announcement, numbers and voice ids only, never the words', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await conversation();
    const stream = await listenEvents(app, conv);
    network({ announcement: { text: ANNOUNCEMENT } });
    const warn = vi.spyOn(console, 'warn');
    const job = await jobRow({ conversationId: conv, replyRendering: 'spoken' });
    await finish(job, RESULT);
    await waitUntil(() => ofJob(stream.events, job).length >= 2);
    await readReply(app, ofJob(stream.events, job)[1]!.data['audioId'] as string);
    await waitUntil(() =>
      warn.mock.calls.some((c) => String(c[0]).startsWith('[voice-job-reply] timing')),
    );
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[voice-job-reply] timing'));
    warn.mockRestore();
    expect(lines).toHaveLength(1);
    const fields = JSON.parse(lines[0]!.slice('[voice-job-reply] timing '.length)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(fields)).toEqual([
      'source',
      'model',
      'voice',
      'transcriptionModel',
      'announcementMs',
      'firstSentenceVendorByteMs',
      'firstSentenceVendorDoneMs',
      'firstAudioMs',
      'lastAudioMs',
    ]);
    expect(fields).toMatchObject({
      source: 'openrouter',
      model: 'google/gemini-3.8-flash-tts',
      voice: 'Kore',
      transcriptionModel: null,
    });
    for (const k of [
      'announcementMs',
      'firstSentenceVendorByteMs',
      'firstSentenceVendorDoneMs',
      'firstAudioMs',
    ]) {
      expect(typeof fields[k]).toBe('number');
    }
    expect(fields['firstAudioMs'] as number).toBeGreaterThanOrEqual(
      fields['announcementMs'] as number,
    );
    expect(fields['lastAudioMs'] as number).toBeGreaterThanOrEqual(
      fields['firstAudioMs'] as number,
    );
    for (const word of ['Microsoft', 'research', 'Nodal']) expect(lines[0]).not.toContain(word);
    stream.close();
  });
});

// ── #976 — the ear: OpenRouter's transcription endpoint, chosen in the setting ─

const ENGLISH_B64 = Buffer.from(FIXTURE).toString('base64');

describe('the voice turn listens with the workspace ear (#976) @cap:parler-a-un-agent/moteur', () => {
  afterEach(async () => {
    clearVoiceCatalog();
    await writeVoiceSetting(db as never, seed.entityId, FIRST_VOICE);
  });

  // Mutation verified: the turn transcribing with a fixed model instead of the
  // resolved one → red.
  it('transcribes with the stored model, through /audio/transcriptions, and the timing line names it', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const app = createApp(makeDeps(), testEnv);
      const conv = await conversation();
      await writeVoiceSetting(db as never, seed.entityId, {
        ...FIRST_VOICE,
        transcriptionModel: 'openai/gpt-transcribe',
      });
      const sent = network({ front: { text: 'Nine in the evening.' } });
      const { body } = await say(app, conv, FIXTURE, { format: 'audio/wav' });
      expect(body['transcript']).toBe(TRANSCRIPT);
      expect(sent.transcription).toEqual([
        {
          url: 'https://openrouter.ai/api/v1/audio/transcriptions',
          body: {
            model: 'openai/gpt-transcribe',
            input_audio: { data: ENGLISH_B64, format: 'wav' },
          },
        },
      ]);
    } finally {
      warn.mockRestore();
    }
    const timing = lines.find((l) => l.startsWith('[voice-turn] timing '))!;
    expect(timing).toContain('"transcriptionModel":"openai/gpt-transcribe"');
  });

  // Mutation verified: `logHearingFailure` not called → red.
  it('a transcription failure is stated to the client and logged with its code, the model and the vendor words', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    let res: Awaited<ReturnType<typeof say>>;
    try {
      const app = createApp(makeDeps(), testEnv);
      const conv = await conversation();
      network({
        transcription: { status: 502, body: { error: { message: 'Upstream provider timed out' } } },
      });
      res = await say(app, conv, FIXTURE, { format: 'audio/wav' });
    } finally {
      warn.mockRestore();
    }
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'transcription_failed',
      detail: 'openrouter x-ai/grok-stt-1.0: HTTP 502 — Upstream provider timed out',
    });
    expect(lines.filter((l) => l.startsWith('[voice-turn] transcription failed'))).toEqual([
      '[voice-turn] transcription failed {"error":"transcription_failed","status":502,"model":"x-ai/grok-stt-1.0","detail":"openrouter x-ai/grok-stt-1.0: HTTP 502 — Upstream provider timed out"}',
    ]);
  });

  it('reads the transcription models OpenRouter serves next to the voices', async () => {
    const app = createApp(makeDeps(), testEnv);
    network({});
    const res = await call(app, 'GET', `/api/voice/setting?entityId=${seed.entityId}`);
    const state = (await res.json()) as { transcription: { state: string; models?: unknown[] } };
    expect(state.transcription).toMatchObject({
      state: 'available',
      models: [
        { id: 'x-ai/grok-stt-1.0', label: 'SpaceXAI: Grok STT 1.0' },
        { id: 'deepgram/nova-3', label: 'Deepgram: Nova-3' },
        { id: 'openai/gpt-transcribe', label: 'OpenAI: GPT Transcribe' },
      ],
      cacheSeconds: 3600,
    });
  });

  /** The probe as the voice says it: the stubbed voice's PCM, as one WAV at 24 kHz. */
  const PROBE_B64 = Buffer.from(pcmToWav(VOICE_PCM, { sampleRate: 24_000 })).toString('base64');

  async function saveEar(
    model: string,
    opts: {
      transcription?: Parameters<typeof network>[0]['transcription'];
      speech?: Parameters<typeof network>[0]['speech'];
    },
  ) {
    const app = createApp(makeDeps(), testEnv);
    const sent = network(opts);
    const res = await call(app, 'PUT', '/api/voice/setting', {
      entityId: seed.entityId,
      setting: { ...FIRST_VOICE, transcriptionModel: model },
    });
    return { res, sent };
  }

  // Mutation verified: the ear check skipped (`earProbeRefusal` not called) →
  // every refusal below is stored instead.
  it('a model that writes down what the voice says is stored: the voice says "OK.", the model transcribes that audio', async () => {
    const { res, sent } = await saveEar('openai/gpt-transcribe', {
      transcription: { status: 200, body: { text: 'Okay.' } },
    });
    expect(res.status).toBe(200);
    // One synthesis with the CURRENT voice, then one transcription of its audio.
    expect(sent.speech).toEqual([
      { model: 'google/gemini-3.8-flash-tts', input: 'OK.', voice: 'Kore', response_format: 'pcm' },
    ]);
    expect(sent.transcription).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/transcriptions',
        body: { model: 'openai/gpt-transcribe', input_audio: { data: PROBE_B64, format: 'wav' } },
      },
    ]);
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: { ...FIRST_VOICE, transcriptionModel: 'openai/gpt-transcribe' },
    });
  });

  it('a model that answers with an error is refused with its words; the row is unchanged', async () => {
    const { res } = await saveEar('openai/gpt-transcribe', {
      transcription: { status: 400, body: { error: { message: 'Unsupported audio format' } } },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'speech_provider_error',
      source: 'openrouter',
      detail: 'openrouter openai/gpt-transcribe: HTTP 400 — Unsupported audio format',
    });
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });
  });

  it('a model that writes something else, or nothing, is refused with what it wrote; the row is unchanged', async () => {
    const answered = await saveEar('openai/gpt-transcribe', {
      transcription: { status: 200, body: { text: 'It is nine in the evening.' } },
    });
    expect(answered.res.status).toBe(409);
    expect(await answered.res.json()).toEqual({
      error: 'transcription_not_faithful',
      source: 'openrouter',
      detail: 'openai/gpt-transcribe wrote "It is nine in the evening." for the voice saying "OK."',
    });
    const empty = await saveEar('deepgram/nova-3', {
      transcription: { status: 200, body: { text: '' } },
    });
    expect(await empty.res.json()).toEqual({
      error: 'transcription_not_faithful',
      source: 'openrouter',
      detail: 'deepgram/nova-3 wrote nothing for the voice saying "OK."',
    });
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });
  });

  // Mutation verified: a voice failure ignored when only the ear changes
  // (the model accepted untested) → red.
  it('a voice that cannot speak blocks the check, said as such, and nothing is accepted untested', async () => {
    const { res, sent } = await saveEar('openai/gpt-transcribe', {
      speech: () =>
        new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      transcription: { status: 200, body: { text: 'OK' } },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'transcription_needs_voice',
      source: 'openrouter',
      detail: 'openrouter google/gemini-3.8-flash-tts: HTTP 402 — Insufficient credits',
    });
    expect(sent.transcription).toEqual([]);
    expect(await readVoiceSetting(db as never, seed.entityId)).toEqual({
      ok: true,
      setting: FIRST_VOICE,
    });
  });

  it('a model OpenRouter does not serve for transcription is refused before anything is said', async () => {
    const { res, sent } = await saveEar('google/gemini-2.5-flash', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'transcription_model_not_offered',
      source: 'openrouter',
      detail: 'google/gemini-2.5-flash',
    });
    expect(sent.speech).toEqual([]);
    expect(sent.transcription).toEqual([]);
  });
});
