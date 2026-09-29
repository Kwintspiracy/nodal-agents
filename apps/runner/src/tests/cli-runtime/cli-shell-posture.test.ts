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
import type * as RulesModule from '../../approvals/rules.ts';
import type * as ShellTurnModule from '../../cli-runtime/shell-turn.ts';

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

// La lecture du frein, qu'un test peut faire échouer (invariant #4 : un frein
// illisible n'est pas un frein desserré).
const brakeRead = vi.hoisted(() => ({ fails: false }));
vi.mock('../../approvals/rules.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof RulesModule>();
  return {
    ...actual,
    isAutoRunPaused: async (...a: Parameters<typeof actual.isAutoRunPaused>) => {
      if (brakeRead.fails) throw new Error('brake read failed (test)');
      return actual.isAutoRunPaused(...a);
    },
  };
});

// La veille du frein relit toutes les 50 ms au lieu de 5 s : la même veille,
// à une cadence de test.
vi.mock('../../cli-runtime/shell-turn.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ShellTurnModule>();
  return {
    ...actual,
    watchBrakeDuringTurn: (...[d, e, p, o]: Parameters<typeof actual.watchBrakeDuringTurn>) =>
      actual.watchBrakeDuringTurn(d, e, p, { ...o, everyMs: 50 }),
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

beforeEach(async () => {
  duringPreflight.hook = null;
  brakeRead.fails = false;
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
            // La CLI « tourne » jusqu'à être tuée (elle sort alors en échec),
            // ou 20 s au plus.
            signalSeen?.addEventListener('abort', () => resolve(killedTurn()), { once: true });
            setTimeout(() => resolve(greenTurn()), 20_000);
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
// projets), sous la prise du run quel que soit le statut ; puis la relecture
// du droit d'agir (un Stop, une reprise l'emportent sur le frein) ; enfin le
// verdict, où le frein ne décrit qu'un tour déjà en échec.
describe('a turn cut by the brake ends like any other turn @cap:executer-une-commande/moteur', () => {
  const shellAgent = (): CliRuntimeAgentRow => ({
    ...baseRow,
    cliPermissions: { mode: 'write', shell: 'auto' },
  });

  /**
   * Une CLI qui écrit un fichier et parle (par le VRAI `onEvent`), puis voit
   * le frein l'arrêter (`cut` : serré par défaut), et tourne jusqu'à être
   * tuée. `thenAlso` : ce qui arrive encore avant qu'elle sorte (un Stop) ;
   * `returns` : ce qu'elle rend en sortant (tuée, par défaut).
   */
  const cliCutByTheBrake = (
    filePath: string | null,
    o: {
      thenAlso?: () => Promise<void>;
      says?: string;
      cut?: () => Promise<unknown>;
      returns?: () => CliTurnResult;
    } = {},
  ) =>
    fakeRun.mockImplementationOnce(
      (opts) =>
        new Promise<CliTurnResult>((resolve) => {
          const onEvent = opts['onEvent'] as (e: ClaudeTurnEvent) => void;
          if (filePath) {
            onEvent({
              kind: 'tool_use',
              toolUseId: 'tu-1',
              toolName: 'Write',
              input: { file_path: filePath },
            });
            onEvent({ kind: 'tool_result', toolUseId: 'tu-1', output: 'ok' });
          }
          if (o.says) onEvent({ kind: 'assistant_text', text: o.says });
          const signal = opts['abortSignal'] as AbortSignal;
          signal.addEventListener(
            'abort',
            () => {
              void (o.thenAlso ? o.thenAlso() : Promise.resolve()).then(() =>
                resolve((o.returns ?? killedTurn)()),
              );
            },
            { once: true },
          );
          (o.cut ?? (() => setBrake(true)))().then(
            () => undefined,
            () => undefined,
          );
        }),
    );

  async function newConversation(): Promise<string> {
    const [conversation] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert failed');
    return conversation.id;
  }

  async function jobInConversation() {
    const conversationId = await newConversation();
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        task: 'go',
        status: 'processing',
        conversationId,
      })
      .returning({ id: agentJobs.id });
    if (!job) throw new Error('job insert failed');
    return { jobId: job.id, conversationId };
  }

  const runJobIn = (jobId: string, conversationId: string, row = shellAgent()) =>
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
      agentRow: row,
      workspaces: [{ label: 'ws', path: root }],
      claimGeneration: 0,
    });

  const runChatIn = (conversationId: string, row = shellAgent(), abortSignal?: AbortSignal) =>
    runCliRuntimeChatTurn({
      db: db as unknown as AnyDrizzleDb,
      entityId: seed.entityId,
      agentRow: row,
      conversationId,
      message: 'lance le rendu',
      ...(abortSignal ? { abortSignal } : {}),
    });

  const jobRow = async (jobId: string) => {
    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        result: agentJobs.result,
        projectId: agentJobs.projectId,
      })
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

  const chatRows = (conversationId: string) =>
    db
      .select({
        content: chatMessages.content,
        stopped: chatMessages.stopped,
        cutReason: chatMessages.cutReason,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId));

  /** Le dossier attaché, déclaré comme projet : c'est à lui qu'un tour de chat se rattache. */
  async function rootDeclared(): Promise<string> {
    const [row] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: normalizePath(root),
        projectKey: projectKey(normalizePath(root)),
        displayName: 'Root',
        agentId: seed.agentId,
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!row) throw new Error('project insert failed');
    return row.id;
  }

  const currentProjectOf = async (conversationId: string) => {
    const [row] = await db
      .select({ currentProjectId: conversations.currentProjectId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row?.currentProjectId ?? null;
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

  // Passe 2 : un Stop pose `cancelled` sans reprendre la ligne. Le run tient
  // encore la PRISE, et le « continue » suivant doit reprendre la session que
  // la CLI tuée avait, pas repartir de zéro.
  it('job path: a Stop that lands with the brake is a cancellation, and the session is kept', async () => {
    const { jobId, conversationId } = await jobInConversation();
    cliCutByTheBrake(join(root, 'a.ts'), {
      thenAlso: async () => {
        // Le chemin d'annulation pose `cancelled` sur la ligne.
        await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
      },
    });

    const outcome = await runJobIn(jobId, conversationId);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await jobRow(jobId)).toMatchObject({ status: 'cancelled', error: null });
    expect(await sessionOf(conversationId)).toBe('sess-killed');
  }, 15_000);

  it('chat path: a Stop that lands with the brake is a stopped answer, not a brake failure', async () => {
    const conversationId = await newConversation();
    const stop = new AbortController();
    cliCutByTheBrake(join(root, 'a.ts'), {
      thenAlso: async () => {
        stop.abort();
      },
    });

    const outcome = await runChatIn(conversationId, shellAgent(), stop.signal);

    expect(outcome).toMatchObject({ ok: true, stopped: true });
    expect(await chatRows(conversationId)).toEqual([
      { content: '', stopped: true, cutReason: null },
    ]);
    expect(await sessionOf(conversationId)).toBe('sess-killed');
  }, 15_000);

  // Passe 2 : le frein ne décrit qu'un tour déjà en échec. Une CLI qui a rendu
  // sa réponse pendant que la veille voyait le frein se serrer n'a pas été
  // tuée : sa réponse part.
  it('job path: a turn that answered while the brake was engaged stays a success', async () => {
    const { jobId, conversationId } = await jobInConversation();
    cliCutByTheBrake(null, { returns: greenTurn });

    const outcome = await runJobIn(jobId, conversationId);

    expect(outcome).toEqual({ status: 'completed', result: 'fait' });
    expect(await jobRow(jobId)).toMatchObject({ status: 'completed', error: null });
  }, 15_000);

  it('chat path: a turn that answered while the brake was engaged stays a success', async () => {
    const conversationId = await newConversation();
    cliCutByTheBrake(null, { returns: greenTurn });

    const outcome = await runChatIn(conversationId);

    expect(outcome).toEqual({ ok: true, reply: 'fait' });
    expect(await chatRows(conversationId)).toEqual([
      { content: 'fait', stopped: false, cutReason: null },
    ]);
  }, 15_000);

  // Passe 2 : côté chat aussi, les enregistrements passent avant le verdict.
  // Le tour a écrit : le fil se rattache au projet ; il a parlé : ce qu'il a
  // dit reste la réponse, avec la raison de l'arrêt, comme sur un Stop.
  it('chat path: a turn the brake cut keeps what it said, and what it wrote joins the project', async () => {
    const projectId = await rootDeclared();
    const conversationId = await newConversation();
    cliCutByTheBrake(join(root, 'a.ts'), { says: 'Je lance le rendu' });

    const outcome = await runChatIn(conversationId);

    expect(outcome).toEqual({
      ok: true,
      reply: 'Je lance le rendu',
      cutReason: 'auto_run_paused',
    });
    expect(await chatRows(conversationId)).toEqual([
      { content: 'Je lance le rendu', stopped: false, cutReason: 'auto_run_paused' },
    ]);
    expect(await currentProjectOf(conversationId)).toBe(projectId);
    expect(await sessionOf(conversationId)).toBe('sess-killed');
  }, 15_000);

  it('chat path: a turn the brake cut before it wrote or said anything moves no project', async () => {
    await rootDeclared();
    const conversationId = await newConversation();
    cliCutByTheBrake(null);

    const outcome = await runChatIn(conversationId);

    expect(outcome).toEqual({ ok: false, error: 'auto_run_paused' });
    expect(await chatRows(conversationId)).toEqual([]);
    expect(await currentProjectOf(conversationId)).toBeNull();
  }, 15_000);
});

// ── Un frein illisible n'est pas un frein desserré (invariant #4) ────────────
//
// Revue Nodal de #551, passe 2 : la veille laissait passer une lecture ratée.
// Un tour qui aurait un shell ne part pas si l'état du frein ne se lit pas, et
// il est coupé si la lecture échoue pendant qu'il tourne. Dans les deux cas,
// il le dit : `auto_run_state_unreadable`.
describe('an unreadable brake stops a turn with a shell, and says so @cap:executer-une-commande/moteur', () => {
  const shellAgent = (): CliRuntimeAgentRow => ({
    ...baseRow,
    cliPermissions: { mode: 'write', shell: 'auto' },
  });

  for (const [path, run] of PATHS) {
    it(`${path} path: a turn with a shell does not start when the brake cannot be read`, async () => {
      brakeRead.fails = true;
      for (const row of [
        shellAgent(),
        { ...baseRow, runtime: 'fake-codex', cliPermissions: null },
      ]) {
        const outcome = await run(row);
        expect(JSON.stringify(outcome), row.runtime).toContain('auto_run_state_unreadable');
      }
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it(`${path} path: a turn with no shell does not need the brake, and runs`, async () => {
      brakeRead.fails = true;
      const outcome = await run({ ...baseRow, cliPermissions: { mode: 'write' } });
      expect(JSON.stringify(outcome)).toContain('fait');
      expect(fakeRun).toHaveBeenCalledTimes(1);
    });

    it(`${path} path: a brake that stops being readable DURING the turn cuts the CLI`, async () => {
      let signalSeen: AbortSignal | undefined;
      fakeRun.mockImplementationOnce(
        (opts) =>
          new Promise<CliTurnResult>((resolve) => {
            signalSeen = opts['abortSignal'] as AbortSignal;
            const done = () => resolve(killedTurn());
            signalSeen.addEventListener('abort', done, { once: true });
            setTimeout(done, 10_000);
            brakeRead.fails = true;
          }),
      );
      const outcome = await run(shellAgent());
      expect(signalSeen?.aborted).toBe(true);
      expect(JSON.stringify(outcome)).toContain('auto_run_state_unreadable');
    }, 15_000);
  }
});
