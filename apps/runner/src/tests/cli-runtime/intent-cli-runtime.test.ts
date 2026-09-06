// intent-cli-runtime.test.ts — la CINQUIÈME surface d'écriture (plan
// « Vérifier & Corriger », T17 / D8) : le runtime CLI écrit sans jamais
// traverser executeTool, donc l'intention de mutation se pose dans
// run-job.ts (et son jumeau run-chat.ts) entre la prise des verrous et le
// spawn. Ce fichier attaque le CÂBLAGE : le binding est injecté (aucun CLI
// réel), et toutes les assertions sont des lignes relues en base.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentWorkspaces,
  codeProjects,
  conversations,
  jobDeliverableVerificationState,
  toolCalls,
  workspaceLocks,
  eq,
} from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type { ClaudeTurnEvent } from '../../cli-runtime/claude-turn.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

// Le binding est INJECTÉ par le tableau des runtimes : `fake-cli` rend un
// binding dont `run` est ce spy — c'est le seul point où un CLI serait lancé.
const fakeRun = vi.fn<(opts: unknown) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-cli'
        ? { provider: 'claude', run: (opts: unknown) => fakeRun(opts), toolLabel: 'cli:fake' }
        : null,
  };
});

// Le prompt n'est pas ce qu'on teste : l'assemblage réel lit une dizaine de
// tables et n'apporte rien à la preuve du câblage.
vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

import { runCliRuntimeJob, AUDIT_WRITES_WAIT_MS } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';
import { runCliRuntimeChatTurn } from '../../cli-runtime/run-chat.ts';

let db: TestDb;
let pg: { exec(sql: string): Promise<unknown> };
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let alpha: string;
let beta: string;
let baseAgent: CliRuntimeAgentRow;

const keyOf = (p: string): string => projectKey(normalizePath(p));

const greenTurn = (): CliTurnResult =>
  ({
    sessionId: 'sess-fake',
    finalText: 'done',
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
  pg = spun.pg;
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
    runtime: 'fake-cli',
    cliPermissions: { mode: 'write' },
    cliDefaults: null,
  };
});

beforeEach(async () => {
  fakeRun.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-intent-cli-'));
  alpha = join(root, 'alpha');
  beta = join(root, 'beta');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  // Chaque dossier porte un manifeste : c'est LUI le projet.
  await writeFile(join(alpha, 'package.json'), '{}');
  await writeFile(join(beta, 'package.json'), '{}');
  await db.delete(workspaceLocks);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function newJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'écris quelque chose',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function runJob(jobId: string, mode: 'read' | 'write', workspaces: string[]) {
  return runCliRuntimeJob({
    db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
    jobId,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'api',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow: { ...baseAgent, cliPermissions: { mode } },
    workspaces: workspaces.map((path, i) => ({ label: `ws${i}`, path })),
  });
}

const statesOf = (jobId: string) =>
  db
    .select({
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
      verifiedGeneration: jobDeliverableVerificationState.verifiedGeneration,
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
    })
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, jobId));

const locksHeld = () => db.select({ path: workspaceLocks.workspacePath }).from(workspaceLocks);

const jobStatus = async (jobId: string): Promise<string | null> => {
  const [row] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row?.status ?? null;
};

describe('run-job : l’intention AVANT binding.run', () => {
  it('write : le binding LÈVE, la ligne d’état existe quand même (dirty 1, verified NULL) et les verrous sont rendus', async () => {
    const jobId = await newJob();
    fakeRun.mockRejectedValueOnce(new Error('binding exploded'));

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow('binding exploded');

    expect(fakeRun).toHaveBeenCalledTimes(1);
    const rows = await statesOf(jobId);
    expect(rows).toEqual([
      {
        canonicalKey: keyOf(alpha),
        dirtyGeneration: 1,
        verifiedGeneration: null,
        decisionStatus: 'dirty',
      },
    ]);
    expect(await locksHeld()).toEqual([]);
  });

  it('read : aucune intention, aucune ligne code_projects', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'read', [alpha]);

    expect(outcome.status).toBe('completed');
    expect(await statesOf(jobId)).toEqual([]);
    expect(await db.select().from(codeProjects)).toEqual([]);
  });

  it('tous les dossiers attachés : deux workspaces ⇒ deux lignes, clés croissantes', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'write', [beta, alpha]);

    expect(outcome.status).toBe('completed');
    const keys = (await statesOf(jobId)).map((r) => r.canonicalKey);
    expect(keys.length).toBe(2);
    expect([...keys].sort()).toEqual([keyOf(alpha), keyOf(beta)].sort());
    expect(await locksHeld()).toEqual([]);
  });

  it('échec d’intention ⇒ le CLI ne démarre pas, le job reste non terminal, les verrous sont rendus', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());
    // La table d'état retirée sous les pieds du helper : un échec RÉEL, pas
    // un mock — c'est le seam de run-job qui doit refuser le spawn.
    await pg.exec('ALTER TABLE job_deliverable_verification_state RENAME TO jdvs_hidden_t17;');
    try {
      await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow(/^verification_intent_failed:/);
    } finally {
      await pg.exec('ALTER TABLE jdvs_hidden_t17 RENAME TO job_deliverable_verification_state;');
    }
    expect(fakeRun).not.toHaveBeenCalled();
    expect(await jobStatus(jobId)).toBe('processing');
    expect(await locksHeld()).toEqual([]);
  });

  it('job déjà terminal (annulé) ⇒ le CLI ne démarre pas', async () => {
    const jobId = await newJob();
    await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
    fakeRun.mockResolvedValueOnce(greenTurn());

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow(
      'verification_intent_failed:intent_already_terminal',
    );
    expect(fakeRun).not.toHaveBeenCalled();
    expect(await statesOf(jobId)).toEqual([]);
    expect(await locksHeld()).toEqual([]);
  });
});

describe('run-chat : le jumeau, sans jobId', () => {
  it('pas de jobId ⇒ aucune ligne, code journalisé, et le tour va quand même jusqu’à binding.run', async () => {
    await db.insert(agentWorkspaces).values({
      agentId: seed.agentId,
      label: 'alpha',
      path: alpha,
      position: 0,
    });
    // Depuis P6, le tour charge le contexte de sa CONVERSATION avant d'appeler
    // le CLI : il lui faut donc une vraie ligne. `conv-t17` n'en était pas un —
    // il ne l'a jamais été, l'ancien chemin ne le lisait simplement jamais sur
    // la branche en erreur.
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, origin: 'user' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('insert conversation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Un tour en erreur : le test s'arrête après le binding, sans écrire de
    // message de chat (pas de conversation à mettre à jour ici).
    fakeRun.mockResolvedValueOnce({ ...greenTurn(), isError: true, errorDetail: 'stop' });
    try {
      const result = await runCliRuntimeChatTurn({
        db: db as unknown as Parameters<typeof runCliRuntimeChatTurn>[0]['db'],
        entityId: seed.entityId,
        agentRow: baseAgent,
        conversationId: conv.id,
        message: 'écris',
      });
      expect(result.ok).toBe(false);
      expect(fakeRun).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(logged.some((l) => l.includes('VERIFICATION_NO_JOB_CONTEXT surface=cliRuntime'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
    expect(await db.select().from(jobDeliverableVerificationState)).toEqual([]);
    expect(await locksHeld()).toEqual([]);
  });
});

describe('run-job : le REGISTRE des projets, APRÈS binding.run (revue passe 27)', () => {
  /** `alpha` déclaré comme projet ENREGISTRÉ (P5) : c'est à lui qu'un tour réussi se rattache. */
  async function alphaEnregistre(): Promise<string> {
    const [row] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: normalizePath(alpha),
        projectKey: keyOf(alpha),
        displayName: 'Alpha',
        agentId: seed.agentId,
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!row) throw new Error('insert projet');
    return row.id;
  }
  const projetDuJob = async (jobId: string): Promise<string | null> => {
    const [row] = await db
      .select({ projectId: agentJobs.projectId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return row?.projectId ?? null;
  };

  it('un tour RÉUSSI dans un projet enregistré rattache le job', async () => {
    const projetId = await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).toBe('completed');
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('le binding LÈVE : rien n’a été produit, le job ne porte aucun projet', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockRejectedValueOnce(new Error('binding exploded'));

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow('binding exploded');
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un tour en ERREUR qui n’a RIEN écrit ne rattache pas', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce({ ...greenTurn(), isError: true, errorDetail: 'stop' });

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).not.toBe('completed');
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un tour en ERREUR qui a ÉCRIT rattache quand même', async () => {
    // Une CLI qui modifie dix fichiers puis sort en rouge parce que les tests
    // échouent a bel et bien produit dans ce projet (revue Codex, passe 28,
    // doute 4). Le signal est `tool_calls` : l'enregistreur d'événements du
    // harnais y pose une ligne par outil interne, et les outils d'édition
    // portent un nom connu (EDIT_TOOLS).
    const projetId = await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockImplementationOnce(async () => {
      // Ce que `onEvent` fait en vrai quand le harnais écrit un fichier.
      await db.insert(toolCalls).values({
        entityId: seed.entityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${alpha}/index.ts` },
        // `tool_output` est du TEXTE, pas du jsonb — voir le schéma.
        toolOutput: '{"ok":true}',
      });
      return { ...greenTurn(), isError: true, errorDetail: 'tests failed' };
    });

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).not.toBe('completed');
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('une ligne tool_calls d’un outil NON éditeur ne vaut pas écriture', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockImplementationOnce(async () => {
      await db.insert(toolCalls).values({
        entityId: seed.entityId,
        jobId,
        toolName: 'cli:Read',
        toolInput: { file_path: `${alpha}/index.ts` },
        toolOutput: '{"ok":true}',
      });
      return { ...greenTurn(), isError: true, errorDetail: 'stop' };
    });

    await runJob(jobId, 'write', [alpha]);

    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('en mode read, un tour réussi ne rattache rien : rien n’a été écrit', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    await runJob(jobId, 'read', [alpha]);

    expect(await projetDuJob(jobId)).toBeNull();
  });
});

describe('run-job : le registre se remplit tout seul (P5b)', () => {
  const ligneDeclaree = async (path: string) => {
    const [row] = await db
      .select({
        id: codeProjects.id,
        registeredAt: codeProjects.registeredAt,
        registeredFrom: codeProjects.registeredFrom,
        registeredJobId: codeProjects.registeredJobId,
        agentId: codeProjects.agentId,
      })
      .from(codeProjects)
      .where(eq(codeProjects.projectKey, keyOf(path)));
    return row && row.registeredAt ? row : null;
  };
  const projetDuJob = async (jobId: string): Promise<string | null> => {
    const [row] = await db
      .select({ projectId: agentJobs.projectId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return row?.projectId ?? null;
  };
  /** Ce que `onEvent` fait en vrai quand le harnais écrit un fichier. */
  const ecritureDuHarnais = (jobId: string, filePath: string) =>
    db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: filePath },
      toolOutput: '{"ok":true}',
    });

  it('deux fichiers écrits dans alpha/src : `alpha` (manifeste) est DÉCLARÉ et le job rattaché — pas le terrain', async () => {
    // Le terrain attaché est `root`, SANS manifeste : ses enfants sont les
    // projets. Sans les chemins écrits, le registre ne saurait pas lequel.
    const jobId = await newJob();
    fakeRun.mockImplementationOnce(async () => {
      await ecritureDuHarnais(jobId, `${alpha}/src/a.ts`);
      await ecritureDuHarnais(jobId, `${alpha}/src/b.ts`);
      return greenTurn();
    });

    const outcome = await runJob(jobId, 'write', [root]);

    expect(outcome.status).toBe('completed');
    const row = await ligneDeclaree(alpha);
    expect(row, 'alpha n’a pas été déclaré').not.toBeNull();
    expect(row).toMatchObject({
      registeredFrom: 'conversation',
      registeredJobId: jobId,
      agentId: seed.agentId,
    });
    expect(await projetDuJob(jobId)).toBe(row!.id);
    expect(await ligneDeclaree(root)).toBeNull();
    // `beta`, salie par l'intention (enfant du terrain) mais jamais écrite :
    // en comptabilité seulement.
    expect(await ligneDeclaree(beta)).toBeNull();
  });

  it('un tour réussi SANS ligne d’édition dans un terrain à manifeste ne déclare RIEN (passe 32)', async () => {
    // « Je vais d'abord analyser la demande », en mode écriture, sans un seul
    // outil d'édition : le repli sur les dossiers attachés RATTACHE (à un
    // projet déjà déclaré), il ne déclare pas — seules les cibles fichier
    // déclarent.
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).toBe('completed');
    expect(await ligneDeclaree(alpha)).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un tour en erreur sans édition ne déclare rien', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce({ ...greenTurn(), isError: true, errorDetail: 'stop' });

    await runJob(jobId, 'write', [root]);

    expect(await ligneDeclaree(alpha)).toBeNull();
    expect(await ligneDeclaree(root)).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('une écriture REFUSÉE par le harnais ne situe rien', async () => {
    const jobId = await newJob();
    fakeRun.mockImplementationOnce(async () => {
      await db.insert(toolCalls).values({
        entityId: seed.entityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${alpha}/src/a.ts` },
        toolOutput: '<tool_use_error>refused</tool_use_error>',
      });
      return { ...greenTurn(), isError: true, errorDetail: 'stop' };
    });

    await runJob(jobId, 'write', [root]);

    expect(await ligneDeclaree(alpha)).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });
});

describe('run-job : les écritures d’audit en vol sont attendues avant de lire les chemins (passe 33)', () => {
  const ligneDeclaree = async (path: string) => {
    const [row] = await db
      .select({ id: codeProjects.id, registeredAt: codeProjects.registeredAt })
      .from(codeProjects)
      .where(eq(codeProjects.projectKey, keyOf(path)));
    return row && row.registeredAt ? row : null;
  };

  /**
   * Une base dont les insertions dans `tool_calls` prennent `delayMs` (ou ne se
   * règlent JAMAIS) : c'est la course réelle — l'enregistreur d'événements
   * lance chaque ligne sans l'attendre, et le dernier événement d'un tour est
   * justement une écriture.
   */
  const dbWithSlowAudit = (delayMs: number | 'never') =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          const q = (
            target as unknown as { insert: (t: unknown) => { values: (v: unknown) => unknown } }
          ).insert(table);
          if (table !== toolCalls) return q;
          return {
            values: (v: unknown) =>
              new Promise((resolve, reject) => {
                if (delayMs === 'never') return;
                setTimeout(() => Promise.resolve(q.values(v)).then(resolve, reject), delayMs);
              }),
          };
        };
      },
    });

  const runWith = (dbLike: unknown, jobId: string) =>
    runCliRuntimeJob({
      db: dbLike as Parameters<typeof runCliRuntimeJob>[0]['db'],
      jobId,
      job: {
        entityId: seed.entityId,
        chatId: null,
        channel: 'api',
        conversationId: null,
        task: 'go',
        triggerContext: null,
      },
      agentRow: { ...baseAgent, cliPermissions: { mode: 'write' } },
      workspaces: [{ label: 'ws0', path: root }],
    });

  /** Le binding factice appelle le VRAI `onEvent` : une écriture du harnais. */
  const ecritureParEvenement = () =>
    fakeRun.mockImplementationOnce(async (opts: unknown) => {
      const { onEvent } = opts as { onEvent: (e: ClaudeTurnEvent) => void };
      onEvent({
        kind: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'Write',
        input: { file_path: `${alpha}/src/a.ts` },
      });
      onEvent({ kind: 'tool_result', toolUseId: 'tu-1', output: 'ok' });
      return greenTurn();
    });

  /**
   * Un double de base SANS horloge (revue Codex, passes 34-35) : l'insertion
   * dans `tool_calls` est RETENUE jusqu'à ce que le test la libère, et le
   * double observe deux choses — quelqu'un a-t-il ATTENDU cette insertion (un
   * `then` posé sur la promesse que `onEvent` garde), et un `select` sur
   * `tool_calls` est-il parti AVANT la libération ? Le test libère l'insertion
   * dès qu'il voit l'un ou l'autre : avec l'attente, c'est le premier ; sans
   * elle, c'est le second, et c'est la faute. Aucune durée n'entre en jeu.
   */
  const dbWithHeldAudit = () => {
    const gate = { awaited: false, readBeforeWrite: false, released: false, release: () => {} };
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          const select = Reflect.get(target, prop, receiver) as (...a: unknown[]) => {
            from: (t: unknown) => unknown;
          };
          return (...args: unknown[]) => {
            const builder = select.apply(target, args);
            return new Proxy(builder, {
              get(b, key, r) {
                if (key !== 'from') return Reflect.get(b, key, r);
                return (table: unknown) => {
                  if (table === toolCalls && !gate.released) gate.readBeforeWrite = true;
                  return b.from(table);
                };
              },
            });
          };
        }
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          const q = (
            target as unknown as { insert: (t: unknown) => { values: (v: unknown) => unknown } }
          ).insert(table);
          if (table !== toolCalls) return q;
          return {
            values: (v: unknown) => {
              const real = new Promise<unknown>((resolve, reject) => {
                gate.release = () => {
                  gate.released = true;
                  Promise.resolve(q.values(v)).then(resolve, reject);
                };
              });
              // Ce que `onEvent` garde : `.catch(...)` sur ce que `values()` rend.
              // Le résultat du `.catch` est un thenable dont le `then` dit
              // « quelqu'un attend cette écriture ».
              return {
                catch: (onRejected: (e: unknown) => unknown) => ({
                  then: (onFulfilled: (v: unknown) => unknown, onRej?: (e: unknown) => unknown) => {
                    gate.awaited = true;
                    return real.catch(onRejected).then(onFulfilled, onRej);
                  },
                }),
              };
            },
          };
        };
      },
    });
    return { proxy, gate };
  };

  it('une insertion d’audit encore en route quand la CLI se termine est ATTENDUE, puis lue (sans horloge)', async () => {
    const { proxy, gate } = dbWithHeldAudit();
    const jobId = await newJob();
    ecritureParEvenement();

    const running = runWith(proxy, jobId);
    // Laisser le tour avancer jusqu'à ce qu'il attende l'écriture (bien) ou
    // lise `tool_calls` sans elle (mal) — puis libérer l'écriture dans les deux
    // cas, pour que le tour finisse et que l'assertion parle.
    while (!gate.awaited && !gate.readBeforeWrite) {
      await new Promise((r) => setImmediate(r));
    }
    gate.release();
    const outcome = await running;

    expect(outcome.status).toBe('completed');
    expect(
      gate.readBeforeWrite,
      'tool_calls a été lu avant que l’écriture d’audit soit posée',
    ).toBe(false);
    expect(gate.awaited).toBe(true);
    const row = await ligneDeclaree(alpha);
    expect(row, 'alpha non déclaré').not.toBeNull();
  });

  it('une insertion d’audit qui ne se règle JAMAIS ne gèle pas le tour : borne, code, et le tour finit', async () => {
    const jobId = await newJob();
    ecritureParEvenement();
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debut = Date.now();
    try {
      const outcome = await runWith(dbWithSlowAudit('never'), jobId);
      expect(outcome.status).toBe('completed');
      const attendu = Date.now() - debut;
      expect(attendu).toBeGreaterThanOrEqual(AUDIT_WRITES_WAIT_MS - 50);
      expect(attendu).toBeLessThan(AUDIT_WRITES_WAIT_MS + 5_000);
      const logged = erreurs.mock.calls.map((c) => c.map(String).join(' '));
      expect(logged.some((l) => l.includes(`CLI_AUDIT_WRITES_TIMEOUT job=${jobId}`))).toBe(true);
    } finally {
      erreurs.mockRestore();
    }
    // Rien n'a été lu : la ligne n'a jamais été posée, alpha n'est pas déclaré.
    expect(await ligneDeclaree(alpha)).toBeNull();
  }, 20_000);
});
