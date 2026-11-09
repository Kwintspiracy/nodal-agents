// spoken-reasoning.test.ts — the reasoning effort of a spoken chat turn (#977).
//
// A chat turn whose reply is HEARD (`replyRendering` 'spoken', #958) thinks
// with the agent's "Reasoning when spoken to"; every other model request keeps
// the agent's Reasoning: a typed turn, and the job a spoken turn launches
// through `run_task` (which inherits `reply_rendering = 'spoken'`). The
// escalation recheck belongs to the turn and thinks like it.
//
// The REAL path: runChatTurn and executeJob, a real test database, the real
// OpenRouter client built from the agent's key, `fetch` stubbed at the network
// boundary. What is asserted is the `reasoning` block of each request body the
// provider receives — what the model is actually asked to do.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, conversations, eq } from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { executeJob } from '../../job/execute.ts';
import {
  makeDeps,
  scriptProvider,
  seedJob,
  testEnv,
  type Body,
  type ScriptedReply,
} from '../job/tool-loading-harness.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

// Catalogued with an effort control and Off (openrouter catalog).
const MODEL = 'anthropic/claude-haiku-5.5';

/** What OpenRouter's builder writes for a stored effort (`buildOpenRouterExtraBody`). */
const wire = (effort: string | null): unknown =>
  effort === null
    ? undefined // Auto: no reasoning block, the provider's default (this model is not `reasoning`)
    : effort === 'off'
      ? { enabled: false }
      : { enabled: true, effort: effort === 'max' ? 'xhigh' : effort };

const reasoningOf = (b: Body): unknown => (b as Body & { reasoning?: unknown }).reasoning;
const offers = (b: Body, tool: string): boolean =>
  (b.tools ?? []).some((t) => t.function.name === tool);
/** Every system message of a request, as text (the prompt can span several). */
const systemText = (b: Body): string =>
  b.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
/** The turn's own reply: the chat system prompt, `run_task` offered. */
const isTurnReply = (b: Body): boolean =>
  offers(b, 'run_task') && systemText(b).includes('- surface: in-app dashboard chat');
/** The escalation recheck (llm/action-recheck.ts): `run_task`, no system prompt. */
const isRecheck = (b: Body): boolean =>
  offers(b, 'run_task') && !b.messages.some((m) => m.role === 'system');

let db: TestDb;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function agentWith(efforts: {
  reasoning: string | null;
  spoken: string | null;
}): Promise<{ entityId: string; agentId: string; conversationId: string }> {
  const { entityId, agentId } = await seedJob(db, { model: MODEL, role: 'orchestrator' });
  await db
    .update(agents)
    .set({ reasoningEffort: efforts.reasoning, spokenReasoningEffort: efforts.spoken })
    .where(eq(agents.id, agentId));
  const [conv] = await db
    .insert(conversations)
    .values({ entityId, agentId, title: 'Voice' })
    .returning();
  if (!conv) throw new Error('conversation insert failed');
  return { entityId, agentId, conversationId: conv.id };
}

async function turn(
  ids: { entityId: string; agentId: string; conversationId: string },
  rendering: 'spoken' | 'text',
  script: ScriptedReply[],
): Promise<{ bodies: Body[]; spawnedJobId: string | undefined }> {
  const bodies = scriptProvider(script);
  const result = await runChatTurn({
    deps: { db } as unknown as RunnerDeps,
    entityId: ids.entityId,
    agentId: ids.agentId,
    conversationId: ids.conversationId,
    message: 'What time is it in Tokyo?',
    onTextDelta: () => {},
    ...(rendering === 'spoken' ? { spoken: { durationMs: 2_400 } } : {}),
  });
  if (!result.ok) throw new Error(`chat turn failed: ${result.error}`);
  vi.unstubAllGlobals();
  return { bodies, spawnedJobId: result.spawnedJobId };
}

// Each row: the two stored efforts, and what each request must carry. Rows
// beyond the ticket's (Off when spoken, Auto typed) prove the general rule:
// any level, either side Auto, and the spoken one never derived from the other.
const ROWS: Array<{ reasoning: string | null; spoken: string | null }> = [
  { reasoning: 'high', spoken: 'off' },
  { reasoning: null, spoken: 'low' },
  { reasoning: 'off', spoken: null },
  { reasoning: 'max', spoken: 'medium' },
];

describe('the effort of a spoken chat turn (#977) @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: run-chat-turn.ts back to `agentRow.reasoningEffort` for
  // every turn → the spoken rows go red (they get the agent's Reasoning).
  it.each(ROWS)(
    'a spoken turn and its recheck send "when spoken to" ($spoken), a typed one Reasoning ($reasoning)',
    async ({ reasoning, spoken }) => {
      const ids = await agentWith({ reasoning, spoken });

      // A text reply with no run_task: the recheck re-reads it once.
      const heard = await turn(ids, 'spoken', [{ text: 'It is noon in Tokyo.' }]);
      const heardReply = heard.bodies.filter(isTurnReply);
      const heardRecheck = heard.bodies.filter(isRecheck);
      expect(heardReply).toHaveLength(1);
      expect(heardRecheck).toHaveLength(1);
      expect({
        reply: reasoningOf(heardReply[0]!),
        recheck: reasoningOf(heardRecheck[0]!),
      }).toEqual({ reply: wire(spoken), recheck: wire(spoken) });

      const read = await turn(ids, 'text', [{ text: 'It is noon in Tokyo.' }]);
      const readReply = read.bodies.filter(isTurnReply);
      const readRecheck = read.bodies.filter(isRecheck);
      expect(readReply).toHaveLength(1);
      expect(readRecheck).toHaveLength(1);
      expect({
        reply: reasoningOf(readReply[0]!),
        recheck: reasoningOf(readRecheck[0]!),
      }).toEqual({ reply: wire(reasoning), recheck: wire(reasoning) });
    },
  );

  // Mutation verified: execute.ts resolving with `spokenReasoningEffort` when
  // the job's reply_rendering is 'spoken' → red (the job gets "off").
  it('the job a spoken turn launches keeps the agent’s Reasoning, and writes its result to be read', async () => {
    const ids = await agentWith({ reasoning: 'high', spoken: 'off' });
    const heard = await turn(ids, 'spoken', [
      { calls: [{ name: 'run_task', args: { instruction: '' } }] },
    ]);
    expect(reasoningOf(heard.bodies.find(isTurnReply)!)).toEqual(wire('off'));
    const jobId = heard.spawnedJobId;
    if (!jobId) throw new Error('the spoken turn launched no job');

    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(row?.replyRendering).toBe('spoken');

    const jobBodies = scriptProvider([{ text: 'It is noon in Tokyo.' }]);
    await executeJob(jobId as JobId, makeDeps(db), testEnv);
    vi.unstubAllGlobals();
    expect(jobBodies.length).toBeGreaterThan(0);
    // Every request of the job, not just the first one.
    expect(jobBodies.map(reasoningOf)).toEqual(jobBodies.map(() => wire('high')));
    // #967: the job's result is read, its prompt no longer says "heard"; what is
    // heard is its announcement (chat/job-reply-voice.ts).
    expect(systemText(jobBodies[0]!)).not.toContain('- rendering:');
  });
});
