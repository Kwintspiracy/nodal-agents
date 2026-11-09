// device-client-e2e.test.ts — the reference device client against the REAL runner (#947, #950).
//
// The runner is the real app (`createApp`), served over HTTP on an ephemeral
// port of 127.0.0.1, on a real database. The device is
// `examples/device/reference-client.mjs`, unmodified, run as its own Node
// process with the BUILT client file (`packages/device-client/dist`), exactly
// as a device maker runs it. Only the providers are simulated, at the network
// boundary, as voice-turn.test.ts does: the transcription, the model and the
// voice.
//
// The scenario, end to end:
//   1. the device pairs: it prints its code, the owner confirms it (the test
//      plays the owner through the owner's route), the device gets its token;
//   2. it says the recorded fixture (`fixtures/voice-turn-question.wav`) as a
//      spoken turn; the agent answers and launches a task (`run_task`);
//   3. the task asks a question (`ask_user`): the card reaches the device, which
//      answers it with its first choice; the task resumes and finishes;
//   4. the reply's voice is written to a file by the device.
//
// What is asserted: what the device printed and wrote, and the rows in base
// (the device row, the answered request, the job's end).
//
// Mutations verified (in packages/device-client/src/nodal-device.ts, rebuilt
// by this test's beforeAll; each turns this test red):
//   - `answer()` sends `cardId` instead of `approvalRequestId`;
//   - the reply's audio passed through undecoded (base64 text);
//   - `pair()` without its `protocolVersion`;
//   - the event stream opened without the device's token.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  approvalRequests,
  devices,
  entities,
  entityLlmKeys,
  eq,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { TITLE_SYSTEM_PROMPT } from '../../chat/conversation-title.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';
// @ts-expect-error — a plain .mjs build script, no declarations
import { buildClient } from '../../../../../packages/device-client/scripts/build.mjs';
import { DEVICE_OWNER_ROUTES } from '@nodal-agents/shared';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

// Provider calls leave through packages/llm's own transport (#608): routed to
// the global fetch, so the stub below is the network boundary.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const REFERENCE_CLIENT = join(REPO, 'examples', 'device', 'reference-client.mjs');
const FIXTURE = fileURLToPath(new URL('../fixtures/voice-turn-question.wav', import.meta.url));
const TRANSCRIPT = 'What time is it in Tokyo?';
const ACK = 'On it, I am checking.';
const QUESTION = 'Which city do you mean?';
const OPTIONS = ['Tokyo', 'Kyoto'];
/** What the voice vendor answers: raw 16-bit PCM, as Gemini TTS does. */
const VOICE_PCM = Uint8Array.from({ length: 480 }, (_, i) => i % 251);

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let server: ServerType;
let app: ReturnType<typeof createApp>;
let baseUrl = '';
let work = '';
const sent = { front: 0, worker: 0, speechInputs: [] as string[] };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-auth',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 1,
  BIND: '127.0.0.1',
  APP_URL: 'http://127.0.0.1:1',
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
  // The task waits for the card's answer in its own run, as it does on a
  // real install, instead of suspending for a worker this test does not run.
  NODALAI_APPROVAL_GRACE_MS: 60_000,
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

/** An OpenAI-compatible answer, streamed or not, with an optional tool call. */
function chatAnswer(
  stream: boolean,
  text: string,
  toolCall: { name: string; args: Record<string, unknown> } | null,
): Response {
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  const finish = toolCall ? 'tool_calls' : 'stop';
  const calls = toolCall
    ? [
        {
          id: `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
        },
      ]
    : undefined;
  if (!stream) {
    const message: Record<string, unknown> = { role: 'assistant', content: text };
    if (calls) message['tool_calls'] = calls;
    return Response.json({ id: 'c', choices: [{ message, finish_reason: finish }], usage });
  }
  const deltas: Array<Record<string, unknown>> = [
    { role: 'assistant', ...(text ? { content: text } : {}) },
  ];
  if (calls) deltas.push({ tool_calls: calls.map((c, index) => ({ index, ...c })) });
  const chunks = [
    ...deltas.map((delta) => ({ id: 'c', choices: [{ index: 0, delta }] })),
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The providers: the ear, the model (front, worker, announcement), the voice. */
function stubProviders(): void {
  let asked = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/models?output_modalities=speech')) {
        return Response.json({
          data: [
            { id: 'google/gemini-3.8-flash-tts', name: 'Gemini TTS', supported_voices: ['Kore'] },
          ],
        });
      }
      if (url.includes('/models?output_modalities=transcription')) {
        return Response.json({ data: [{ id: 'openai/gpt-transcribe', name: 'GPT Transcribe' }] });
      }
      if (url.endsWith('/audio/transcriptions')) return Response.json({ text: TRANSCRIPT });
      if (url.endsWith('/audio/speech')) {
        const req = JSON.parse(init?.body as string) as { input: string };
        sent.speechInputs.push(req.input);
        return new Response(VOICE_PCM, { status: 200, headers: { 'content-type': 'audio/pcm' } });
      }
      if (!url.includes('/chat/completions'))
        throw new Error(`device-client-e2e: no network for ${url}`);
      const body = JSON.parse(init?.body as string) as {
        stream?: boolean;
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const stream = body.stream === true;
      const system = textOf(body.messages.find((m) => m.role === 'system')?.content);
      const last = textOf(body.messages[body.messages.length - 1]?.content);
      if (system.startsWith(TITLE_SYSTEM_PROMPT.slice(0, 40)))
        return chatAnswer(stream, 'Tokyo time', null);
      if (system.includes('\n## Announcement\n')) return chatAnswer(stream, 'It is done.', null);
      if (last.endsWith(ACTION_RECHECK)) return chatAnswer(stream, 'ok', null);
      if ((body.tools ?? []).some((t) => t.function.name === 'run_task')) {
        sent.front++;
        return chatAnswer(stream, ACK, { name: 'run_task', args: { instruction: TRANSCRIPT } });
      }
      sent.worker++;
      if (!asked) {
        asked = true;
        return chatAnswer(stream, '', {
          name: 'ask_user',
          args: { question: QUESTION, options: OPTIONS },
        });
      }
      return chatAnswer(stream, 'It is 9 pm in Tokyo.', null);
    }),
  );
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
  await db
    .update(agents)
    .set({ llmKeyId: key!.id, model: 'z-ai/glm-5.3', role: 'orchestrator' })
    .where(eq(agents.id, seed.agentId));
  await db
    .update(entities)
    .set({ rootAgentId: seed.agentId })
    .where(eq(entities.id, seed.entityId));

  // The device runs the BUILT file, the one a device project copies.
  await buildClient();

  stubProviders();
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
  app = createApp(deps, testEnv);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = mkdtempSync(join(tmpdir(), 'nodal-device-e2e-'));
});

/**
 * The owner confirms the request whose code the device shows, as the dashboard
 * does from Settings → Devices: the owner's routes, with the worker secret and
 * the workspace read from the session.
 */
async function confirmAsOwner(userCode: string): Promise<void> {
  const owner = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const list = await app.fetch(
    new Request(
      `http://localhost${DEVICE_OWNER_ROUTES.listPairings.path}?entityId=${seed.entityId}`,
      {
        headers: owner,
      },
    ),
  );
  expect(list.status).toBe(200);
  const { pairings } = (await list.json()) as {
    pairings: Array<{ pairingId: string; userCode: string }>;
  };
  const waiting = pairings.find((p) => p.userCode === userCode);
  expect(waiting, `a request with code ${userCode}`).toBeDefined();
  const confirmed = await app.fetch(
    new Request(
      `http://localhost${DEVICE_OWNER_ROUTES.confirmPairing.path.replace(':pairingId', waiting!.pairingId)}`,
      { method: 'POST', headers: owner, body: JSON.stringify({ entityId: seed.entityId }) },
    ),
  );
  expect(confirmed.status).toBe(200);
}

let child: ChildProcess | null = null;
afterAll(async () => {
  child?.kill();
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('the reference device client, end to end on the real runner (#947) @cap:parler-par-canal-externe/moteur', () => {
  it('pairs, says a recorded question, answers the card of the task it launched, and writes the reply’s voice', async () => {
    const out = join(work, 'reply.pcm');
    let stdout = '';
    let stderr = '';
    const exited = new Promise<number | null>((resolve) => {
      child = spawn(process.execPath, [REFERENCE_CLIENT, baseUrl, FIXTURE, out], {
        cwd: work,
        env: { ...process.env, NODAL_SESSION_FILE: join(work, 'session.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('exit', (code) => resolve(code));
    });

    // 1. Pairing: the device prints its code; the owner confirms it.
    const deadline = Date.now() + 30_000;
    let code: string | undefined;
    while (!(code = /Pairing code: (\d{6})/.exec(stdout)?.[1])) {
      if (Date.now() > deadline)
        throw new Error(`no pairing code; stdout: ${stdout} stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await confirmAsOwner(code);

    const exitCode = await exited;
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

    // 2. The spoken turn: heard, answered, the task launched.
    expect(stdout).toContain(`Heard: ${TRANSCRIPT}\nReply: ${ACK}`);
    // 3. The card the task asked reached the device, which answered it.
    expect(stdout).toContain(`→ ${OPTIONS[0]}`);
    expect(stdout).toContain('Job: done');
    // 4. The reply's voice, as the device wrote it: the vendor's PCM, whole.
    expect(existsSync(out)).toBe(true);
    expect(new Uint8Array(readFileSync(out))).toEqual(VOICE_PCM);
    expect(sent.speechInputs).toContain(ACK);

    // The rows: the device is paired in this workspace, the question was
    // answered with the device's choice, and the task finished.
    const session = JSON.parse(readFileSync(join(work, 'session.json'), 'utf8')) as {
      deviceId: string;
      token: string;
    };
    expect(session.token).toMatch(/^ndv_[A-Za-z0-9_-]{43}$/);
    const [device] = await db.select().from(devices).where(eq(devices.id, session.deviceId));
    expect(device).toMatchObject({ entityId: seed.entityId, name: 'Reference client' });
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.kind, 'question'));
    expect(request).toMatchObject({ status: 'approved', answer: OPTIONS[0] });
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, request!.jobId));
    expect(job).toMatchObject({ status: 'completed', channel: 'device', chatId: session.deviceId });
  });
});
