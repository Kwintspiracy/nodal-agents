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
// La ligne est aussi relue JUSTE avant le lancement : une annulation tombée
// pendant la préparation du tour ne lance aucun processus (passe 2).
//
// Ce qui ne se prouve PAS ici, et n'est pas vrai aujourd'hui : qu'un agent
// servi par une CLI exécute lui-même un « stop ». Il ne reçoit aucun outil
// Nodal (#574) ; ses runs s'arrêtent par le bouton Stop ou par un root servi
// par le runtime Nodal.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, workspaceLocks, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
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

// La préparation du tour passe par l'assemblage du prompt : le retenir ici
// retient la préparation, le temps d'annuler la ligne (revue Codex de #572,
// passe 2).
let preparationGate: Promise<void> | null = null;
const preparationReached = vi.fn();

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return {
    ...actual,
    buildSystemPrompt: async () => {
      preparationReached();
      if (preparationGate) await preparationGate;
      return 'system prompt (test)';
    },
  };
});

import { runCliRuntimeJob, JOB_ROW_POLL_MS } from '../../cli-runtime/run-job.ts';
import { JOB_ROW_UNREADABLE_MAX, claimJob } from '../../job/state.ts';
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
  preparationReached.mockReset();
  preparationGate = null;
  await db.delete(workspaceLocks);
});

describe('a job served by a CLI runtime acts only while its row says processing @cap:parler-par-canal-externe/moteur', () => {
  it.each(['claude-code', 'codex'] as const)(
    '%s: stop_conversation_run, called by a later head of the conversation, cuts the earlier CLI run',
    async (runtime) => {
      const conversationId = randomUUID();
      // L'agent est servi par ce runtime, en base comme dans le binding.
      await db.update(agents).set({ runtime }).where(eq(agents.id, seed.agentId));
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
      // L'outil est appelé directement, comme son job le ferait : en production,
      // seul un job de tête servi par le runtime Nodal le possède — un job
      // servi par une CLI ne reçoit aucun outil Nodal (#574).
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
      const fallbackMs = JOB_ROW_POLL_MS * 6;
      fakeRun.mockImplementationOnce(turnUntilAborted(fallbackMs));
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
        // Une ligne insérée `processing` porte la prise 0 : ce run la tient.
        claimGeneration: 0,
      });

      // Le job de tête du message 2 arrête ce qui tourne dans la conversation.
      await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      const stopped = await stopConversationRunTool.execute({}, {
        jobId: later!.id,
        agentId: seed.agentId,
        entityId: seed.entityId,
        db: db as unknown as ToolContext['db'],
        jobChatId: null,
      } as ToolContext);
      expect(stopped.stopped.map((s) => s.run_id)).toEqual([earlier!.id]);
      // Ce que le modèle lit de cet arrêt est vrai pour CE runtime : son
      // processus est tué, pas « un appel en cours finit d'abord ».
      expect(stopped.how_each_job_stops).toEqual([
        {
          job_id: earlier!.id,
          runtime,
          how:
            `Its ${runtime === 'codex' ? 'Codex' : 'Claude Code'} process is killed within ` +
            'seconds, wherever it is in its work; a turn not yet started never starts.',
        },
      ]);

      const outcome = await running;

      expect(outcome).toEqual({ status: 'cancelled' });
      // Coupé par l'arrêt, pas arrivé au bout de son travail.
      expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      const [row] = await db
        .select({ status: agentJobs.status, result: agentJobs.result })
        .from(agentJobs)
        .where(eq(agentJobs.id, earlier!.id));
      expect(row).toEqual({ status: 'cancelled', result: null });
    },
    30_000,
  );

  it.each([
    ['claude-code', 'failed'],
    ['codex', 'failed'],
    ['claude-code', 'pending'],
    ['codex', 'pending'],
  ] as const)(
    '%s: a row another writer sets to %s cuts the turn, and the run writes nothing over it',
    async (runtime, status) => {
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
      const fallbackMs = JOB_ROW_POLL_MS * 6;
      fakeRun.mockImplementationOnce(turnUntilAborted(fallbackMs));
      const running = runCliRuntimeJob({
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
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
        // Une ligne insérée `processing` porte la prise 0 : ce run la tient.
        claimGeneration: 0,
      });

      // Le faucheur déclare le job mort, ou le remet en file, pendant le tour.
      await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      await db.update(agentJobs).set({ status }).where(eq(agentJobs.id, job!.id));

      const outcome = await running;

      expect(outcome).toEqual({ status: 'already_handled' });
      expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      // Le statut posé par l'autre reste le sien.
      const [row] = await db
        .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
        .from(agentJobs)
        .where(eq(agentJobs.id, job!.id));
      expect(row).toEqual({ status, result: null, error: null });
    },
    30_000,
  );

  it.each([
    ['claude-code', 'cancelled', { status: 'cancelled' }],
    ['codex', 'cancelled', { status: 'cancelled' }],
    ['claude-code', 'failed', { status: 'already_handled' }],
    ['codex', 'failed', { status: 'already_handled' }],
  ] as const)(
    '%s: a row set to %s while the turn is being prepared never spawns the CLI',
    async (runtime, status, expected) => {
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
      let release!: () => void;
      preparationGate = new Promise<void>((r) => (release = r));
      fakeRun.mockImplementation(turnUntilAborted(JOB_ROW_POLL_MS * 6));

      const running = runCliRuntimeJob({
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
        // En écriture : c'est le mode qui prend les verrous du dossier et pose
        // l'intention de mutation, la préparation la plus longue.
        agentRow: { ...baseAgent, runtime, cliPermissions: { mode: 'write' } },
        workspaces: [{ label: 'ws0', path: workspace }],
        // Une ligne insérée `processing` porte la prise 0 : ce run la tient.
        claimGeneration: 0,
      });

      // La préparation est en cours ; la ligne change sous elle ; on relâche.
      await vi.waitFor(() => expect(preparationReached).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      });
      await db.update(agentJobs).set({ status }).where(eq(agentJobs.id, job!.id));
      release();

      expect(await running).toEqual(expected);
      // Aucun processus : le binding n'a jamais été appelé.
      expect(fakeRun).not.toHaveBeenCalled();
      const [row] = await db
        .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
        .from(agentJobs)
        .where(eq(agentJobs.id, job!.id));
      expect(row).toEqual({ status, result: null, error: null });
      // Les verrous du dossier sont rendus.
      expect(await db.select().from(workspaceLocks)).toEqual([]);
    },
    30_000,
  );

  it.each(['claude-code', 'codex'] as const)(
    '%s: a row that cannot be read any more cuts the turn and fails the run, saying so',
    async (runtime) => {
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
      // La base du run, dont les LECTURES échouent pendant le tour (connexion
      // perdue) ; les écritures passent, pour que l'échec puisse être écrit.
      let readsBroken = false;
      const flaky = new Proxy(db as unknown as AnyDrizzleDb, {
        get(target, prop) {
          if (prop === 'select' && readsBroken) {
            return () => {
              throw new Error('connection terminated unexpectedly');
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      const fallbackMs = JOB_ROW_POLL_MS * (JOB_ROW_UNREADABLE_MAX + 6);
      fakeRun.mockImplementationOnce((opts) => {
        readsBroken = true;
        opts.abortSignal?.addEventListener('abort', () => (readsBroken = false), { once: true });
        return turnUntilAborted(fallbackMs)(opts);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await runCliRuntimeJob({
        db: flaky as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
        jobId: job!.id,
        job: {
          entityId: seed.entityId,
          chatId: null,
          channel: 'api',
          conversationId: null,
          task: 'go',
          triggerContext: null,
        },
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
        // Une ligne insérée `processing` porte la prise 0 : ce run la tient.
        claimGeneration: 0,
      });
      const logged = errors.mock.calls.map((c) => String(c[0]));
      errors.mockRestore();

      expect(outcome).toEqual({ status: 'failed', error: 'job_row_unreadable' });
      // Coupé, pas arrivé au bout : une ligne illisible n'autorise rien.
      expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      const [row] = await db
        .select({ status: agentJobs.status, error: agentJobs.error })
        .from(agentJobs)
        .where(eq(agentJobs.id, job!.id));
      expect(row).toEqual({ status: 'failed', error: 'job_row_unreadable' });
      // Chaque lecture ratée est dite, jusqu'au seuil.
      expect(logged.filter((l) => l.includes('JOB_ROW_UNREADABLE'))).toHaveLength(
        JOB_ROW_UNREADABLE_MAX,
      );
    },
    30_000,
  );

  // Revue Codex de #575, passe 4 : la veille d'un tour de CLI ne lisait que le
  // STATUT. Un job remis en file par le faucheur puis repris par un autre run
  // redit `processing` — sous une AUTRE prise — et le processus de l'ancien
  // run continuait d'agir. La veille lit désormais l'autorité de la ligne sous
  // la prise du run (`readJobAuthority`), la même que la boucle Nodal.
  it.each(['claude-code', 'codex'] as const)(
    '%s: a row taken by ANOTHER run between two tool effects cuts the process before the second',
    async (runtime) => {
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'api',
          task: 'go',
          status: 'processing',
          messages: [],
        })
        .returning({ id: agentJobs.id });
      const effets: string[] = [];
      let entreDeuxEffets!: () => void;
      const premierEffetFait = new Promise<void>((r) => (entreDeuxEffets = r));
      fakeRun.mockImplementationOnce(
        (opts) =>
          new Promise<CliTurnResult>((resolve) => {
            // Le premier effet d'outil de la CLI.
            effets.push('effet-1');
            entreDeuxEffets();
            const fin = (coupe: boolean) =>
              resolve({
                sessionId: 'sess-fake',
                finalText: coupe ? '' : 'done',
                isError: coupe,
                errorDetail: coupe ? 'killed' : null,
                usage: null,
                modelUsage: null,
                costUsd: null,
                numTurns: 1,
                durationMs: 5,
                exitCode: coupe ? null : 0,
                timedOut: false,
                rateLimit: null,
                permissionDenials: 0,
                unknownEventTypes: [],
              } as unknown as CliTurnResult);
            // Le second effet, bien après plusieurs relectures — sauf si le
            // processus est tué avant.
            const second = setTimeout(() => {
              effets.push('effet-2');
              fin(false);
            }, JOB_ROW_POLL_MS * 6);
            opts.abortSignal?.addEventListener(
              'abort',
              () => {
                clearTimeout(second);
                fin(true);
              },
              { once: true },
            );
          }),
      );
      const running = runCliRuntimeJob({
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
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
        claimGeneration: 0,
      });

      await premierEffetFait;
      // Le faucheur remet le job en file ; un autre run le prend (prise 1).
      const lAutre = [{ role: 'user', content: 'la transcription de l’autre run' }];
      await db
        .update(agentJobs)
        .set({ status: 'pending', messages: lAutre })
        .where(eq(agentJobs.id, job!.id));
      expect(await claimJob(db as unknown as AnyDrizzleDb, job!.id)).toBe(1);

      const outcome = await running;

      expect(effets).toEqual(['effet-1']);
      expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
      expect(outcome).toEqual({ status: 'already_handled' });
      // La ligne est celle de l'autre run : ni son statut ni sa transcription
      // ne sont réécrits.
      const [row] = await db
        .select({
          status: agentJobs.status,
          messages: agentJobs.messages,
          result: agentJobs.result,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, job!.id));
      expect(row).toEqual({ status: 'processing', messages: lAutre, result: null });
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
    fakeRun.mockImplementationOnce(turnUntilAborted(JOB_ROW_POLL_MS * 2));

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
      claimGeneration: 0,
    });

    expect(outcome).toEqual({ status: 'completed', result: 'portrait generated' });
    expect(fakeRun.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
  }, 30_000);
});
