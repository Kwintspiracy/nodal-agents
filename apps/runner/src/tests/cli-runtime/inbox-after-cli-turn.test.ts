// inbox-after-cli-turn.test.ts — un job servi par une CLI (Claude Code, Codex)
// ne lit pas sa file PENDANT son travail : un tour de CLI n'a pas de frontière
// de tour où la boucle Nodal la viderait (#531). Ce qu'un tour de réponse lui a
// transmis pendant ce tour n'est pas perdu pour autant : à la fin du job, le
// déclencheur de la transition terminale (migration 0141) en fait une nouvelle
// tête de la conversation, qui le lit.
//
// Le binding est injecté (aucun CLI réel), comme dans cancel-cli-runtime.test.ts.
//
// Mutation vérifiée : le déclencheur retiré (helpers.ts) → ce test rougit (le
// message reste dans la file d'un job terminé, aucune tête ne le porte).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  conversations,
  and,
  asc,
  eq,
  isNull,
  deliverToConversationJob,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnOptions, CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

const fakeRun = vi.fn<(opts: CliTurnOptions) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'claude-code' || runtime === 'codex'
        ? {
            provider: runtime === 'codex' ? 'codex' : 'claude',
            run: (opts: CliTurnOptions) => fakeRun(opts),
            toolLabel: `cli:${runtime}`,
          }
        : null,
  };
});

/** Le contexte de job que le runtime CLI a passé au prompt, relu par les tests. */
const promptContexts: unknown[] = [];

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return {
    ...actual,
    buildSystemPrompt: async (_agent: unknown, _db: unknown, jobContext: unknown) => {
      promptContexts.push(jobContext);
      return 'system prompt (test)';
    },
  };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let baseAgent: CliRuntimeAgentRow;
let workspace: string;

const FOLLOW_UP = 'et mets-le dans le dossier partagé';

function finished(text: string): CliTurnResult {
  return {
    sessionId: 'sess-fake',
    finalText: text,
    isError: false,
    errorDetail: null,
    usage: null,
    modelUsage: null,
    costUsd: null,
    numTurns: 1,
    durationMs: 5,
    exitCode: 0,
    timedOut: false,
    rateLimit: null,
    permissionDenials: 0,
    unknownEventTypes: [],
  } as unknown as CliTurnResult;
}

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  workspace = await mkdtemp(join(tmpdir(), 'nodal-inbox-cli-'));
  seed = await seedMinimal(db);
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!row) throw new Error('seed agent missing');
  baseAgent = {
    id: row.id as CliRuntimeAgentRow['id'],
    name: row.name,
    slug: row.slug,
    role: 'agent',
    personality: row.personality ?? '',
    entityId: seed.entityId as CliRuntimeAgentRow['entityId'],
    model: 'test-model',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 4000,
    runtime: 'claude-code',
    cliPermissions: { mode: 'read' },
    cliDefaults: null,
  };
});

describe('a job served by a CLI reads its inbox AFTER its turn, through a new head (#531) @cap:parler-par-canal-externe/moteur', () => {
  it.each(['claude-code', 'codex'] as const)(
    '%s: a message written during the CLI turn is not in that turn, and becomes the next head when the job ends',
    async (runtime) => {
      await db.update(agents).set({ runtime }).where(eq(agents.id, seed.agentId));
      const [conv] = await db
        .insert(conversations)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          chatId: '5',
        })
        .returning({ id: conversations.id });
      const conversationId = conv!.id;
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          chatId: '5',
          conversationId,
          task: 'Fais-moi un portrait',
          status: 'processing',
        })
        .returning({ id: agentJobs.id });

      fakeRun.mockReset();
      fakeRun.mockImplementationOnce(async () => {
        // Un tour de réponse transmet PENDANT le tour de CLI : le message va dans la file.
        const delivery = await deliverToConversationJob(db as unknown as AnyDrizzleDb, {
          entityId: seed.entityId,
          conversationId,
          jobId: job!.id,
          text: FOLLOW_UP,
        });
        expect(delivery).toMatchObject({ delivered: true, jobId: job!.id });
        return finished('portrait generated');
      });

      const outcome = await runCliRuntimeJob({
        db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
        jobId: job!.id,
        job: {
          entityId: seed.entityId,
          chatId: '5',
          channel: 'telegram',
          conversationId,
          task: 'Fais-moi un portrait',
          triggerContext: null,
        },
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
        claimGeneration: 0,
      });

      expect(outcome.status).toBe('completed');
      // Le tour de CLI n'a pas vu le message : il n'a pas de frontière de tour.
      expect(fakeRun.mock.calls[0]?.[0].message).not.toContain(FOLLOW_UP);
      const heads = await db
        .select({
          id: agentJobs.id,
          status: agentJobs.status,
          task: agentJobs.task,
          inbox: agentJobs.inbox,
        })
        .from(agentJobs)
        .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
        .orderBy(asc(agentJobs.createdAt));
      expect(heads.map((h) => ({ status: h.status, task: h.task, inbox: h.inbox }))).toEqual([
        { status: 'completed', task: 'Fais-moi un portrait', inbox: [] },
        { status: 'pending', task: FOLLOW_UP, inbox: [] },
      ]);
    },
    30_000,
  );

  it('a REPLY TURN served by a CLI gets the running work in its prompt, on the CLI surface (no Nodal tool offered)', async () => {
    await db.update(agents).set({ runtime: 'claude-code' }).where(eq(agents.id, seed.agentId));
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '6' })
      .returning({ id: conversations.id });
    const conversationId = conv!.id;
    const [head] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '6',
        conversationId,
        task: 'Fais-moi un portrait',
        status: 'awaiting_delegation',
      })
      .returning({ id: agentJobs.id });
    const [reply] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '6',
        conversationId,
        task: FOLLOW_UP,
        status: 'processing',
        answersWhileJobId: head!.id,
      })
      .returning({ id: agentJobs.id });
    fakeRun.mockReset();
    fakeRun.mockResolvedValueOnce(finished('Je vois le portrait en cours ; /stop l’arrête.'));
    promptContexts.length = 0;

    const outcome = await runCliRuntimeJob({
      db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
      jobId: reply!.id,
      job: {
        entityId: seed.entityId,
        chatId: '6',
        channel: 'telegram',
        conversationId,
        task: FOLLOW_UP,
        triggerContext: null,
        answersWhileJobId: head!.id,
      },
      agentRow: { ...baseAgent, runtime: 'claude-code' },
      workspaces: [{ label: 'ws0', path: workspace }],
      claimGeneration: 0,
    });

    expect(outcome.status).toBe('completed');
    const ctx = promptContexts[0] as {
      surface?: string;
      conversation?: {
        runningWork?: { runs: Array<{ runId: string; status: string; task: string }> };
      };
    };
    expect(ctx.surface).toBe('cli-runtime');
    expect(ctx.conversation?.runningWork?.runs.map((r) => [r.runId, r.status, r.task])).toEqual([
      [head!.id, 'awaiting_delegation', 'Fais-moi un portrait'],
    ]);
  }, 30_000);
});
