// cli-shell-posture.test.ts — ce que la CLI reçoit pour les commandes shell,
// depuis la ligne de l'agent en base, sur les DEUX chemins CLI (#494).
//
// Run ef3185be : un agent sur le runtime claude-code a refusé toutes ses
// commandes (« requires approval »), et l'équipe a proposé au propriétaire
// d'approuver ou d'activer le Yolo, deux gestes qui n'atteignaient pas la CLI.
// Ces tests lisent l'option que le binding reçoit VRAIMENT (le binding est
// simulé, pas la décision), pour chaque combinaison que le propriétaire peut
// régler, sur le chemin job et sur le chemin chat, et avec le frein d'urgence.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, agentWorkspaces, conversations, entities, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

const fakeRun = vi.fn<(opts: Record<string, unknown>) => Promise<CliTurnResult>>();
/** Ce qui se passe PENDANT la préparation du tour (la construction du prompt). */
const duringPreflight = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

// Deux runtimes factices, un par CLI : la règle est celle de la CLI qui sert le
// tour, et un runtime nouveau sur une CLI connue doit en hériter.
vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-claude' || runtime === 'fake-codex'
        ? {
            provider: runtime === 'fake-claude' ? 'claude' : 'codex',
            run: (opts: Record<string, unknown>) => fakeRun(opts),
            toolLabel: `cli:${runtime}`,
          }
        : null,
  };
});

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return {
    ...actual,
    buildSystemPrompt: async () => {
      if (duringPreflight.hook) await duringPreflight.hook();
      return 'system prompt (test)';
    },
  };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import { runCliRuntimeChatTurn } from '../../cli-runtime/run-chat.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let baseRow: CliRuntimeAgentRow;

const greenTurn = (): CliTurnResult =>
  ({
    sessionId: 'sess-fake',
    finalText: 'fait',
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
  }) as unknown as CliTurnResult;

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!row) throw new Error('seed agent missing');
  baseRow = {
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
    runtime: 'fake-claude',
    cliPermissions: null,
    cliDefaults: null,
  };
});

beforeEach(async () => {
  duringPreflight.hook = null;
  fakeRun.mockReset();
  fakeRun.mockResolvedValue(greenTurn());
  root = await mkdtemp(join(tmpdir(), 'nodal-494-'));
  await db.update(entities).set({ autoRunPaused: false }).where(eq(entities.id, seed.entityId));
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
  await db.insert(agentWorkspaces).values({ agentId: seed.agentId, label: 'ws', path: root });
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function runJob(row: CliRuntimeAgentRow) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'go',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return runCliRuntimeJob({
    db: db as unknown as AnyDrizzleDb,
    jobId: job.id,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'dashboard',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow: row,
    workspaces: [{ label: 'ws', path: root }],
  });
}

async function runChat(row: CliRuntimeAgentRow) {
  const [conversation] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('conversation insert failed');
  return runCliRuntimeChatTurn({
    db: db as unknown as AnyDrizzleDb,
    entityId: seed.entityId,
    agentRow: row,
    conversationId: conversation.id,
    message: 'lance le rendu',
  });
}

/** Les outils shell que le binding a reçus, au dernier tour. */
function shellToolsSent(): unknown {
  const opts = fakeRun.mock.calls.at(-1)?.[0];
  if (!opts) throw new Error('the CLI turn never started');
  return opts['shellTools'];
}

const setBrake = (paused: boolean) =>
  db.update(entities).set({ autoRunPaused: paused }).where(eq(entities.id, seed.entityId));

const PATHS = [
  ['job', runJob],
  ['chat', runChat],
] as const;

const BOTH = ['Bash', 'PowerShell'];

describe('CLI runtime shell posture, from the agent row @cap:executer-une-commande/moteur', () => {
  for (const [path, run] of PATHS) {
    it(`${path} path, claude CLI: commands only in write mode with shell 'auto', minus what is forbidden`, async () => {
      const cases: [CliRuntimeAgentRow['cliPermissions'], string[]][] = [
        [null, []],
        [{ mode: 'read' }, []],
        [{ mode: 'read', shell: 'auto' }, []],
        [{ mode: 'write' }, []],
        [{ mode: 'write', shell: 'none' }, []],
        [{ mode: 'write', shell: 'auto' }, BOTH],
        // L'interdiction l'emporte : un seul outil retiré laisse l'autre, les
        // deux retirés ne laissent aucun shell (revue Codex de #494).
        [{ mode: 'write', shell: 'auto', extraDisallowed: ['Bash'] }, ['PowerShell']],
        [{ mode: 'write', shell: 'auto', extraDisallowed: BOTH }, []],
      ];
      for (const [cliPermissions, expected] of cases) {
        await run({ ...baseRow, cliPermissions });
        expect(shellToolsSent(), JSON.stringify(cliPermissions)).toEqual(expected);
      }
    });

    it(`${path} path, brake on: Claude still answers, with no shell; Codex does not start`, async () => {
      await setBrake(true);
      // Claude sait perdre son shell : une conversation ou une relecture reste
      // possible sous le frein, sans aucune commande.
      await run({ ...baseRow, cliPermissions: { mode: 'write', shell: 'auto' } });
      expect(shellToolsSent()).toEqual([]);
      fakeRun.mockClear();
      // Codex ne sait pas : il lancerait ses commandes dans son bac à sable.
      const outcome = await run({ ...baseRow, runtime: 'fake-codex', cliPermissions: null });
      expect(JSON.stringify(outcome)).toContain('auto_run_paused');
      expect(fakeRun).not.toHaveBeenCalled();
    });

    // Revue Codex de #494, passe 3 : le frein était lu à l'entrée seulement.
    // Serré pendant la préparation (verrous, git, prompt), il laissait partir le
    // tour avec la posture d'avant.
    it(`${path} path: the brake engaged during the PREPARATION decides the turn`, async () => {
      duringPreflight.hook = async () => {
        await setBrake(true);
      };
      await run({ ...baseRow, cliPermissions: { mode: 'write', shell: 'auto' } });
      expect(shellToolsSent()).toEqual([]);
      fakeRun.mockClear();
      await setBrake(false);
      const outcome = await run({ ...baseRow, runtime: 'fake-codex', cliPermissions: null });
      expect(JSON.stringify(outcome)).toContain('auto_run_paused');
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it(`${path} path: the brake engaged DURING a turn with a shell cuts the CLI`, async () => {
      let signalSeen: AbortSignal | undefined;
      fakeRun.mockImplementationOnce(
        (opts) =>
          new Promise<CliTurnResult>((resolve) => {
            signalSeen = opts['abortSignal'] as AbortSignal | undefined;
            // La CLI « tourne » jusqu'à être tuée, ou 20 s au plus.
            const done = () => resolve(greenTurn());
            signalSeen?.addEventListener('abort', done, { once: true });
            setTimeout(done, 20_000);
            // Le propriétaire serre le frein pendant le tour.
            // (Une requête Drizzle est paresseuse : c'est `then` qui la lance.)
            setBrake(true).then(
              () => undefined,
              () => undefined,
            );
          }),
      );
      const outcome = await run({ ...baseRow, cliPermissions: { mode: 'write', shell: 'auto' } });
      expect(signalSeen?.aborted).toBe(true);
      expect(JSON.stringify(outcome)).toContain('auto_run_paused');
    }, 15_000);
  }
});
