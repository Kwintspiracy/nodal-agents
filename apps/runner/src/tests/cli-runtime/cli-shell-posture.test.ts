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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentWorkspaces,
  chatMessages,
  cliSessions,
  codeProjects,
  conversations,
  entities,
  and,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type { ClaudeTurnEvent } from '../../cli-runtime/claude-turn.ts';
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
    // La ligne insérée ci-dessus porte la prise par défaut (#566).
    claimGeneration: 0,
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

// ── La fin d'un tour coupé par le frein (revue Nodal de #551) ────────────────
//
// UN seul ordre de fin de tour, quelle que soit la sortie : d'abord les
// enregistrements de ce que le processus a fait (session, registre des
// projets), tant que la prise est tenue ; puis la relecture du droit d'agir
// (un Stop, une reprise l'emportent sur le frein) ; enfin le verdict.
describe('a turn cut by the brake ends like any other turn @cap:executer-une-commande/moteur', () => {
  const shellAgent = (): CliRuntimeAgentRow => ({
    ...baseRow,
    cliPermissions: { mode: 'write', shell: 'auto' },
  });

  /** Ce qu'une CLI tuée rend : pas de texte final, une erreur. */
  const killedTurn = (): CliTurnResult =>
    ({
      ...greenTurn(),
      sessionId: 'sess-killed',
      finalText: '',
      isError: true,
      errorDetail: 'killed',
      exitCode: null,
    }) as unknown as CliTurnResult;

  /**
   * Une CLI qui écrit un fichier (par le VRAI `onEvent`), voit le propriétaire
   * serrer le frein, et tourne jusqu'à être tuée. `thenAlso` : ce qui arrive
   * encore avant qu'elle sorte (un Stop).
   */
  const cliCutByTheBrake = (filePath: string, thenAlso?: () => Promise<void>) =>
    fakeRun.mockImplementationOnce(
      (opts) =>
        new Promise<CliTurnResult>((resolve) => {
          const onEvent = opts['onEvent'] as (e: ClaudeTurnEvent) => void;
          onEvent({
            kind: 'tool_use',
            toolUseId: 'tu-1',
            toolName: 'Write',
            input: { file_path: filePath },
          });
          onEvent({ kind: 'tool_result', toolUseId: 'tu-1', output: 'ok' });
          const signal = opts['abortSignal'] as AbortSignal;
          signal.addEventListener(
            'abort',
            () => {
              void (thenAlso ? thenAlso() : Promise.resolve()).then(() => resolve(killedTurn()));
            },
            { once: true },
          );
          setBrake(true).then(
            () => undefined,
            () => undefined,
          );
        }),
    );

  async function jobInConversation() {
    const [conversation] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert failed');
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        task: 'go',
        status: 'processing',
        conversationId: conversation.id,
      })
      .returning({ id: agentJobs.id });
    if (!job) throw new Error('job insert failed');
    return { jobId: job.id, conversationId: conversation.id };
  }

  const runJobIn = (jobId: string, conversationId: string) =>
    runCliRuntimeJob({
      db: db as unknown as AnyDrizzleDb,
      jobId,
      job: {
        entityId: seed.entityId,
        chatId: null,
        channel: 'dashboard',
        conversationId,
        task: 'go',
        triggerContext: null,
      },
      agentRow: shellAgent(),
      workspaces: [{ label: 'ws', path: root }],
      claimGeneration: 0,
    });

  const jobRow = async (jobId: string) => {
    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error, projectId: agentJobs.projectId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return row;
  };

  const sessionOf = async (conversationKey: string) => {
    const [row] = await db
      .select({ sessionId: cliSessions.sessionId })
      .from(cliSessions)
      .where(
        and(
          eq(cliSessions.agentId, seed.agentId),
          eq(cliSessions.conversationKey, conversationKey),
        ),
      );
    return row?.sessionId ?? null;
  };

  it('job path: the session and the project registry are written before the brake verdict', async () => {
    // Un projet : le dossier attaché porte un manifeste.
    await writeFile(join(root, 'package.json'), '{}');
    const { jobId, conversationId } = await jobInConversation();
    cliCutByTheBrake(join(root, 'src', 'a.ts'));

    const outcome = await runJobIn(jobId, conversationId);

    expect(outcome).toEqual({ status: 'failed', error: 'auto_run_paused' });
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'failed', error: 'auto_run_paused' });
    // La CLI a travaillé avant d'être tuée : le prochain message reprend SA
    // session, et le projet où elle a écrit est déclaré, le job rattaché.
    expect(await sessionOf(conversationId)).toBe('sess-killed');
    const [project] = await db
      .select({ id: codeProjects.id, registeredJobId: codeProjects.registeredJobId })
      .from(codeProjects)
      .where(eq(codeProjects.projectKey, projectKey(normalizePath(root))));
    expect(project?.registeredJobId).toBe(jobId);
    expect(row?.projectId).toBe(project?.id);
  }, 15_000);

  it('job path: a Stop that lands with the brake is a cancellation, not a brake failure', async () => {
    const { jobId, conversationId } = await jobInConversation();
    cliCutByTheBrake(join(root, 'a.ts'), async () => {
      // Le chemin d'annulation pose `cancelled` sur la ligne.
      await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
    });

    const outcome = await runJobIn(jobId, conversationId);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await jobRow(jobId)).toMatchObject({ status: 'cancelled', error: null });
    // La session est un ÉTAT que le message suivant lit : seul un run qui
    // tient encore le job l'écrit (#566).
    expect(await sessionOf(conversationId)).toBeNull();
  }, 15_000);

  it('chat path: a Stop that lands with the brake is a stopped answer, not a brake failure', async () => {
    const [conversation] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert failed');
    const stop = new AbortController();
    cliCutByTheBrake(join(root, 'a.ts'), async () => {
      stop.abort();
    });

    const outcome = await runCliRuntimeChatTurn({
      db: db as unknown as AnyDrizzleDb,
      entityId: seed.entityId,
      agentRow: shellAgent(),
      conversationId: conversation.id,
      message: 'lance le rendu',
      abortSignal: stop.signal,
    });

    expect(outcome).toMatchObject({ ok: true, stopped: true });
    const stored = await db
      .select({ stopped: chatMessages.stopped, role: chatMessages.role })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversation.id));
    expect(stored).toEqual([{ stopped: true, role: 'assistant' }]);
    expect(await sessionOf(conversation.id)).toBe('sess-killed');
  }, 15_000);
});
