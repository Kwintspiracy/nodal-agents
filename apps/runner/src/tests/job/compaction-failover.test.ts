// compaction-failover.test.ts — the context compaction (Guard 1c) keys on the
// window of the model that SERVES, and fires BEFORE the call that would cross
// it (review of #905, pass 2).
//
// The threshold was computed once, from the primary, at the job's start. A
// failover chain moves its active model during the job and picks a link
// inside a call: a large-window primary failing over to a small-window
// fallback kept compacting at 0.7 × the primary's window, and the call to the
// fallback died with `context_window_exceeded` instead of compacting.
//
// The REAL path: executeJob, a real test database, the real file_read, the
// real failover client (OpenRouter's builder, two keys), the provider requests
// read at the fetch boundary. The fallback is a model the catalog does not
// know, its window set on its key (`entity_llm_keys.context_window`), and it
// refuses a request that does not fit, as a provider does.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, agentWorkspaces, entityLlmKeys, eq } from '@nodal-agents/db';
import { encrypt } from '@nodal-agents/secrets';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import {
  makeDeps,
  scriptProvider,
  seedJob,
  testEnv,
  type Body,
  type ScriptedReply,
} from './tool-loading-harness.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

// A catalogued model with a large window (far above what this job sends).
const LARGE = 'anthropic/claude-haiku-5.5';
// Unknown to the catalog: its window is the one its key states.
const SMALL = 'nodal-test/small-window-model';
const SMALL_WINDOW = 20_000;

// Files of ~5 000 estimated tokens each: four of them are 20 000, over 0.7 ×
// 20 000, far under 0.7 × the large window. The small model takes three.
const FILES = [1, 2, 3, 4, 5].map((n) => ({
  name: `chapter-${n}.txt`,
  marker: `CHAPTER-${n}-START`,
  text: `CHAPTER-${n}-START\n` + `Line of chapter ${n}, words and words. `.repeat(500),
}));

let db: TestDb;
let dir: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-compaction-failover-')));
  for (const f of FILES) await writeFile(join(dir, f.name), f.text);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** A job on `primary`, with `fallback` behind it on a second key whose window is `window`. */
async function chain(primary: string, fallback: string, window: number): Promise<string> {
  const { jobId, entityId, agentId } = await seedJob(db, { model: primary, role: 'agent' });
  const [second] = await db
    .insert(entityLlmKeys)
    .values({
      entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-fallback-key'),
      baseUrl: null,
      nickname: 'OpenRouter (small window)',
      isActive: true,
      contextWindow: window,
    })
    .returning();
  if (!second) throw new Error('failed to seed the fallback key');
  await db
    .update(agents)
    .set({ fallbackChain: [{ keyId: second.id, model: fallback }] })
    .where(eq(agents.id, agentId));
  await db
    .insert(agentWorkspaces)
    .values({ agentId, entityId, label: 'ws', path: dir, position: 0 });
  return jobId;
}

/**
 * Run the job: `failing` out of credits from its `from`-th request on, and the
 * small-window model refusing any request that carries four chapters or more
 * (they do not fit its window). Returns every request SERVED.
 */
async function run(
  jobId: string,
  script: ScriptedReply[],
  failing: { model: string; from: number },
): Promise<Body[]> {
  const served = scriptProvider(script);
  const answer = globalThis.fetch;
  let seen = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? '{}');
    const body = JSON.parse(raw) as Body;
    if (body.model === failing.model && ++seen >= failing.from) {
      return new Response(
        JSON.stringify({
          error: { message: 'Insufficient credits. Add more credits.', code: 429 },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.model === SMALL && FILES.filter((f) => raw.includes(f.marker)).length >= 4) {
      return new Response(
        JSON.stringify({
          error: {
            message: `This model's maximum context length is ${SMALL_WINDOW} tokens.`,
            code: 400,
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return answer(input, init);
  });
  await executeJob(jobId as JobId, makeDeps(db), testEnv);
  vi.unstubAllGlobals();
  return served;
}

const reads = (count: number): ScriptedReply[] =>
  FILES.slice(0, count).map((f) => ({
    calls: [{ name: 'file_read', args: { path: join(dir, f.name) } }],
  }));

describe('compaction keys on the window of the model that serves, through a failover chain @cap:suivre-execution/moteur', () => {
  it('a large-window primary fails over to a small-window fallback: the request is compacted before it is sent', async () => {
    const jobId = await chain(LARGE, SMALL, SMALL_WINDOW);
    // Requests 1-4 (the primary) read the four chapters; request 5 fails over.
    const served = await run(jobId, [...reads(4), { text: 'Done.' }], { model: LARGE, from: 5 });

    expect(served.map((b) => b.model)).toEqual([LARGE, LARGE, LARGE, LARGE, SMALL]);
    // The primary, whose window is large, never compacted: its last request holds every chapter.
    const lastOfPrimary = JSON.stringify(served[3]);
    for (const f of FILES.slice(0, 3)) expect(lastOfPrimary).toContain(f.marker);
    // The fallback's request was compacted for ITS window: the oldest result is elided.
    const toFallback = JSON.stringify(served[4]);
    expect(toFallback).not.toContain(FILES[0]!.marker);
    expect(toFallback).toContain('earlier tool result elided to fit the context window');
    for (const f of FILES.slice(1, 4)) expect(toFallback).toContain(f.marker);

    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('completed');
    expect(row?.error ?? null).toBeNull();
  });

  it('once the fallback serves, the transcript itself is compacted before its next call', async () => {
    const jobId = await chain(LARGE, SMALL, SMALL_WINDOW);
    // The primary is out from its 5th request: the fallback serves the 5th read's turn
    // (its request compacted for it) and the next, now the ACTIVE model.
    const served = await run(jobId, [...reads(5), { text: 'Done.' }], { model: LARGE, from: 5 });

    expect(served.map((b) => b.model)).toEqual([LARGE, LARGE, LARGE, LARGE, SMALL, SMALL]);
    const sixth = JSON.stringify(served[5]);
    expect(sixth).not.toContain(FILES[0]!.marker);
    expect(sixth).not.toContain(FILES[1]!.marker);
    for (const f of FILES.slice(2)) expect(sixth).toContain(f.marker);
    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('completed');
    // What is kept is compacted: the next execution starts from the fitted transcript.
    expect(JSON.stringify(row?.messages)).not.toContain(FILES[0]!.marker);
    expect(JSON.stringify(row?.messages)).not.toContain(FILES[1]!.marker);
  });
});
