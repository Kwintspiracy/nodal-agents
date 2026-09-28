// cancel-cli-runtime.test.ts — l'arrêt atteint un job servi par une CLI (#567,
// revue Codex de #572, passe 1).
//
// Le chemin d'annulation unique (`cancelJobTree` : le bouton Stop du web et
// `stop_conversation_run`) passe le job à `cancelled` en base. La boucle Nodal
// relit ce statut à chaque tour ; un job en runtime Claude Code ou Codex, lui,
// est UN tour de CLI qui peut durer quinze minutes, et `runCliRuntimeJob` ne
// relisait jamais rien : la ligne disait `cancelled` pendant que le processus
// continuait d'écrire dans le dossier de travail.
//
// Le binding est injecté (aucun CLI réel) : ce qui se prouve ici, c'est que
// run-job observe l'annulation et coupe le tour par le signal que les deux CLI
// honorent déjà (claude-turn.ts et codex-turn.ts le passent à spawnCliTurn,
// dont spawn-turn-stop.test.ts prouve qu'il tue l'arbre de processus).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, workspaceLocks, eq } from '@nodal-agents/db';
import { stopConversationRunTool } from '@nodal-agents/tools';
import type { ToolContext } from '@nodal-agents/tools';
import type { CliTurnOptions, CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

const fakeRun = vi.fn<(opts: CliTurnOptions) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    // Les deux runtimes servis, sous leur vrai fournisseur : le chemin job ne
    // les distingue que par `provider` et `toolLabel`.
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

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

import { runCliRuntimeJob, CANCEL_POLL_MS } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let baseAgent: CliRuntimeAgentRow;
let workspace: string;

/**
 * Un tour qui ne finit que coupé : il rend la main quand le signal tombe, ou
 * après `fallbackMs` comme une CLI qui aurait fini son travail malgré l'arrêt.
 */
function turnUntilAborted(fallbackMs: number) {
  return (opts: CliTurnOptions): Promise<CliTurnResult> =>
    new Promise((resolve) => {
      const done = (aborted: boolean) =>
        resolve({
          sessionId: 'sess-fake',
          finalText: aborted ? '' : 'portrait generated',
          isError: aborted,
          errorDetail: aborted ? 'killed' : null,
          usage: null,
          modelUsage: null,
          costUsd: null,
          numTurns: 1,
          durationMs: 5,
          exitCode: aborted ? null : 0,
          timedOut: false,
          rateLimit: null,
          permissionDenials: 0,
          unknownEventTypes: [],
        } as unknown as CliTurnResult);
      const timer = setTimeout(() => done(false), fallbackMs);
      opts.abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          done(true);
        },
        { once: true },
      );
    });
}

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  workspace = await mkdtemp(join(tmpdir(), 'nodal-cancel-cli-'));
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

beforeEach(async () => {
  fakeRun.mockReset();
  await db.delete(workspaceLocks);
});

describe('a job served by a CLI runtime stops when the shared cancel path cancels it @cap:parler-par-canal-externe/moteur', () => {
  it.each(['claude-code', 'codex'] as const)(
    '%s: a later message of the conversation stops the earlier CLI job, whose turn is cut',
    async (runtime) => {
      const conversationId = randomUUID();
      // Message 1 : servi par la CLI, il tourne.
      const [earlier] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          conversationId,
          task: 'Fais-moi un portrait',
          status: 'processing',
        })
        .returning({ id: agentJobs.id });
      // Message 2 : « Arrête !!! », un job de tête neuf de la même conversation.
      const [later] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram',
          conversationId,
          task: 'Arrête !!!',
          status: 'processing',
        })
        .returning({ id: agentJobs.id });

      // Bien au-delà d'un intervalle de relecture : sans relecture, le tour va
      // à son terme et le test le voit.
      const fallbackMs = CANCEL_POLL_MS * 6;
      fakeRun.mockImplementationOnce(turnUntilAborted(fallbackMs));
      const started = Date.now();
      const running = runCliRuntimeJob({
        db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
        jobId: earlier!.id,
        job: {
          entityId: seed.entityId,
          chatId: null,
          channel: 'telegram',
          conversationId,
          task: 'Fais-moi un portrait',
          triggerContext: null,
        },
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
      });

      // Le job de tête du message 2 arrête ce qui tourne dans la conversation.
      await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledTimes(1));
      const stopped = await stopConversationRunTool.execute({}, {
        jobId: later!.id,
        agentId: seed.agentId,
        entityId: seed.entityId,
        db: db as unknown as ToolContext['db'],
        jobChatId: null,
      } as ToolContext);
      expect(stopped.stopped.map((s) => s.run_id)).toEqual([earlier!.id]);

      const outcome = await running;

      expect(outcome).toEqual({ status: 'cancelled' });
      // Coupé par l'arrêt, pas arrivé au bout de son travail.
      expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(fallbackMs);
      const [row] = await db
        .select({ status: agentJobs.status, result: agentJobs.result })
        .from(agentJobs)
        .where(eq(agentJobs.id, earlier!.id));
      expect(row).toEqual({ status: 'cancelled', result: null });
    },
    30_000,
  );

  it('a CLI job nobody cancels runs its turn to the end', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'go',
        status: 'processing',
      })
      .returning({ id: agentJobs.id });
    fakeRun.mockImplementationOnce(turnUntilAborted(CANCEL_POLL_MS * 2));

    const outcome = await runCliRuntimeJob({
      db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
      jobId: job!.id,
      job: {
        entityId: seed.entityId,
        chatId: null,
        channel: 'api',
        conversationId: null,
        task: 'go',
        triggerContext: null,
      },
      agentRow: { ...baseAgent, runtime: 'codex' },
      workspaces: [{ label: 'ws0', path: workspace }],
    });

    expect(outcome).toEqual({ status: 'completed', result: 'portrait generated' });
    expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
  }, 30_000);
});
