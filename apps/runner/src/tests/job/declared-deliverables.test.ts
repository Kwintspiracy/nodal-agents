// declared-deliverables.test.ts — un fichier que l'agent DÉCLARE livrer est
// vérifié avant que le run puisse finir en succès (issue #509).
//
// Le run qui a ouvert l'issue : Montage écrit un projet Remotion, lance le
// rendu (exit 0, aucun MP4 écrit), puis rend succès sur « Film livré, rendu
// terminé ». La preuve est verte sur les sources ; rien ne regarde le MP4.
//
// Ces tests passent par le VRAI `executeJob`, avec un modèle simulé, un vrai
// dossier de travail et une vraie base, et n'affirment que des LIGNES relues
// en base (statut, erreur, `result`, états de vérification, lignes de preuve)
// et le texte que le parent recevrait.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  agents,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  entities,
  jobDeliverableVerificationState,
  verificationRuns,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob, delegationRecordFromOutcome } from '../../job/execute.ts';
import { deliverableNotVerifiedLine, finalizeJobSuccess } from '../../job/finalize.ts';
import type { JobId } from '@nodal-agents/orchestration';

vi.setConfig({ testTimeout: 30_000 });

// ─── Interception du client LLM (même harnais que run-command-flow.test.ts) ──

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('declared-deliverables.test: no active LLM client');
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

/** Le client simulé, et les PROMPTS qu'il a reçus — un par appel. */
function makeMockLlmClient(responses: MockResponse[]): {
  client: RunnerDeps['llmClient'];
  prompts: string[];
} {
  let callIndex = 0;
  const prompts: string[] = [];
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: `${tc.toolCallId}-${callIndex}`,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
  return { client, prompts };
}

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
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
  NODALAI_APPROVAL_GRACE_MS: 0,
};

// ─── État ─────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let ws: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));
  ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-declared-run-')));
  // `file_write`, pour le run qui écrit un document SANS rien déclarer.
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Files ${Date.now()}`,
      slug: `files-declared-${Date.now()}`,
      content: 'write files',
      requiredBuiltins: ['file_write'],
    })
    .returning();
  if (!skill) throw new Error('skill insert failed');
  await db
    .insert(agentSkillAssignments)
    .values({ entityId: seed.entityId, agentId: seed.agentId, skillId: skill.id });
  await db.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'ws',
    path: ws,
    position: 0,
  });
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  // Le réglage par défaut de l'espace : UN tour de réparation (D2).
  await db.update(entities).set({ proofRepairAttempts: 1 }).where(eq(entities.id, seed.entityId));
});

function makeDeps(client: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(client);
  return {
    db: db as RunnerDeps['db'],
    llmClient: client,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function createJob(task: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

async function jobRow(id: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      runnerNotes: agentJobs.runnerNotes,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, id));
  if (!row) throw new Error('job not found');
  return row;
}

const statesOf = (id: string) =>
  db
    .select()
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, id));

const runsOf = (id: string) =>
  db.select().from(verificationRuns).where(eq(verificationRuns.jobId, id));

const keyOf = (p: string): string => projectKey(normalizePath(p));

/** Un MP4 minimal : une boîte `ftyp`, puis des octets binaires. */
function mp4Bytes(): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(32, 0);
  b.write('ftypisom', 4, 'ascii');
  b[40] = 0xff;
  return b;
}

const rendu = (id: string, text: string, deliverables?: string[]): MockResponse => ({
  text,
  toolCalls: [
    {
      toolCallId: id,
      toolName: 'return_result',
      args: deliverables ? { status: 'success', deliverables } : { status: 'success' },
    },
  ],
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('un livrable DÉCLARÉ est vérifié avant le succès @cap:verifier-un-livrable/moteur', () => {
  it('le MP4 promis n’existe pas : tour de réparation, toujours absent, le run ÉCHOUE et le dit', async () => {
    const id = await createJob('rends le film');
    const { client, prompts } = makeMockLlmClient([
      rendu('rr-1', 'Film livré, rendu terminé.', ['film.mp4']),
      // Le tour de réparation : l'agent réaffirme, sans rien produire.
      rendu('rr-2', 'Rendu relancé, film livré.', ['film.mp4']),
    ]);

    const out = await executeJob(id as JobId, makeDeps(client), testEnv);

    // Deux appels au modèle : le tour, puis LE tour de réparation, et rien de plus.
    expect(prompts).toHaveLength(2);
    // Le tour de réparation a reçu la preuve rouge, qui nomme le fichier.
    expect(prompts[1]).toContain('film.mp4');
    expect(prompts[1]).toContain('not found');

    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    // Le dernier texte du run, PUIS la ligne de plateforme.
    const abs = normalizePath(join(ws, 'film.mp4'));
    expect(row.result).toContain('Rendu relancé, film livré.');
    expect(row.result).toContain('[stopped: declared deliverable not verified — ');
    expect(row.result).toContain(`${abs}: exists (`);
    expect(row.result).toMatch(/film\.mp4 not found\)\]$/);
    expect(row.result!.indexOf('Rendu relancé')).toBeLessThan(row.result!.indexOf('[stopped:'));
    // The line is the runner's, and says so apart from the agent's text (#562):
    // the replay of the thread files it in the runner record.
    expect(row.runnerNotes).toEqual([row.result!.slice(row.result!.indexOf('[stopped:'))]);

    // La ligne d'état : déclarée, rouge, réparation consommée, rouge compté.
    const states = await statesOf(id);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      deliverableType: 'document',
      canonicalKey: keyOf(abs),
      declared: true,
      decisionStatus: 'red',
      repairAttempts: 1,
      redStreak: 1,
    });
    // La preuve a bien REGARDÉ le MP4, deux fois : `exists` rouge.
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.canonicalKey, r.command, r.verdict])).toEqual([
      [keyOf(abs), 'exists', 'red'],
      [keyOf(abs), 'exists', 'red'],
    ]);

    // Ce que le parent reçoit d'un enfant délégué : le même texte, en échec.
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') throw new Error('unreachable');
    expect(out.result).toBe(row.result);
    const record = delegationRecordFromOutcome(out);
    expect(record).toMatchObject({ status: 'failed', error: 'deliverable_not_verified' });
    expect(record.summary).toContain('film.mp4 not found');
  });

  it('le MP4 promis est là et c’est un MP4 : completed, preuve verte sur le fichier', async () => {
    await writeFile(join(ws, 'vrai-film.mp4'), mp4Bytes());
    const id = await createJob('rends le vrai film');
    const { client, prompts } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', ['vrai-film.mp4']),
    ]);

    const out = await executeJob(id as JobId, makeDeps(client), testEnv);

    expect(out.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.result).toBe('Film livré.');
    const abs = normalizePath(join(ws, 'vrai-film.mp4'));
    const states = await statesOf(id);
    expect(states.map((s) => [s.canonicalKey, s.declared, s.decisionStatus])).toEqual([
      [keyOf(abs), true, 'green'],
    ]);
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.command, r.verdict])).toEqual([
      ['exists', 'green'],
      ['not-empty', 'green'],
      ['well-formed:mp4', 'green'],
    ]);
  });

  it('un fichier présent mais qui n’est PAS ce qu’il prétend être échoue aussi, sur son en-tête', async () => {
    await writeFile(join(ws, 'faux-film.mp4'), '{"error":"render failed"}');
    const id = await createJob('rends un faux film');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', ['faux-film.mp4']),
      rendu('rr-2', 'Film livré, promis.', ['faux-film.mp4']),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain('faux-film.mp4: well-formed:mp4 (no ISO media box header');
  });

  it('réparé en changeant de fichier : la liste corrigée REMPLACE l’ancienne, completed (revue Codex, passe 3)', async () => {
    // Le brouillon est invalide ; au tour de réparation l'agent rend le film
    // final et ne déclare plus que lui. Avant : le brouillon restait déclaré et
    // rouge, et le run échouait alors que tout ce qu'il livrait était bon.
    await writeFile(join(ws, 'draft.mp4'), '{"error":"half render"}');
    await writeFile(join(ws, 'final.mp4'), mp4Bytes());
    const id = await createJob('rends le film, corrige si besoin');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', ['draft.mp4']),
      rendu('rr-2', 'Film final livré.', ['final.mp4']),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    const states = await statesOf(id);
    const parCle = new Map(states.map((s) => [s.canonicalKey, s.declared]));
    expect(parCle.get(keyOf(normalizePath(join(ws, 'draft.mp4'))))).toBe(false);
    expect(parCle.get(keyOf(normalizePath(join(ws, 'final.mp4'))))).toBe(true);
  });

  it('un texte DÉJÀ publié par un outil de livraison reçoit la ligne d’arrêt, écrite AVEC l’échec (revue Codex, passe 3)', async () => {
    // Un outil de livraison a déjà écrit « Film livré. » dans le résultat ;
    // puis la déclaration s'avère impossible à vérifier. Le résultat doit dire
    // les deux — et dans la transaction qui pose l'échec, pas par une seconde
    // écriture qu'une panne pourrait perdre.
    const dehors = normalizePath(join(tmpdir(), `hors-dossier-publie-${Date.now()}`, 'film.mp4'));
    const id = await createJob('rends un film ailleurs, texte déjà publié');
    await db.update(agentJobs).set({ result: 'Film livré.' }).where(eq(agentJobs.id, id));
    const { client } = makeMockLlmClient([
      rendu('rr-1', '', [dehors]),
      rendu('rr-2', '', [dehors]),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.result).toBe(
      `Film livré.\n\n${deliverableNotVerifiedLine([
        { path: dehors, check: 'unresolved', detail: 'path_traversal_blocked' },
      ])}`,
    );
  });

  it('réparé SANS répéter la liste (champ omis) : la promesse tient, le brouillon rouge fait échouer', async () => {
    // Omettre le champ ne retire rien : un agent qui oublie de répéter sa liste
    // ne se libère pas en silence d'un fichier qu'il a promis.
    await writeFile(join(ws, 'brouillon.mp4'), '{"error":"half render"}');
    const id = await createJob('rends le film');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', ['brouillon.mp4']),
      rendu('rr-2', 'Film livré, cette fois.'),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
  });

  it('zéro réparation accordée par l’espace : échec DIRECT, sans tour de plus', async () => {
    await db.update(entities).set({ proofRepairAttempts: 0 }).where(eq(entities.id, seed.entityId));
    const id = await createJob('rends le film sans filet');
    const { client, prompts } = makeMockLlmClient([rendu('rr-1', 'Film livré.', ['absent.mp4'])]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    expect(prompts).toHaveLength(1);
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain('Film livré.');
    expect(row.result).toContain('absent.mp4 not found');
    const states = await statesOf(id);
    expect(states.map((s) => [s.declared, s.decisionStatus, s.repairAttempts])).toEqual([
      [true, 'red', 0],
    ]);
  });

  it('un chemin qui ne désigne rien de ses dossiers : UN renvoi à l’agent, puis l’échec', async () => {
    const dehors = normalizePath(join(tmpdir(), `hors-dossier-${Date.now()}`, 'film.mp4'));
    const id = await createJob('rends un film ailleurs');
    const { client, prompts } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', [dehors]),
      rendu('rr-2', 'Film livré, vraiment.', [dehors]),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    expect(prompts).toHaveLength(2);
    // Le renvoi donne à l'agent la raison du résolveur des outils de fichiers.
    expect(prompts[1]).toContain('deliverables_unresolved');
    expect(prompts[1]).toContain('does not reside in any configured workspace');
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain('Film livré, vraiment.');
    expect(row.result).toContain(
      deliverableNotVerifiedLine([
        { path: dehors, check: 'unresolved', detail: 'path_traversal_blocked' },
      ]),
    );
    expect(await statesOf(id)).toHaveLength(0);
  });

  it('renvoyé, l’agent répond en TEXTE SEUL : la déclaration reste due, le run échoue (revue Codex)', async () => {
    // Sans la dette relue dans la transcription, la sortie « texte seul »
    // finalisait en succès : aucune ligne déclarée, rien à opposer.
    const dehors = normalizePath(join(tmpdir(), `hors-dossier-texte-${Date.now()}`, 'film.mp4'));
    const id = await createJob('rends un film ailleurs, puis réponds en texte');
    const { client, prompts } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', [dehors]),
      { text: 'Film livré.' },
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    expect(prompts).toHaveLength(2);
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    const line = deliverableNotVerifiedLine([
      { path: dehors, check: 'unresolved', detail: 'path_traversal_blocked' },
    ]);
    expect(row.result).toContain(line);
    // Same line, recorded as the runner's (#562).
    expect(row.runnerNotes).toEqual([line]);
  });

  it('renvoyé, l’agent rappelle return_result en OMETTANT le champ : la promesse tient, le run échoue (revue Codex de la PR #523)', async () => {
    // Omettre, ce n'est pas retirer : le champ absent garde la liste
    // précédente, et elle ne désigne rien de vérifiable.
    const dehors = normalizePath(join(tmpdir(), `hors-dossier-omis-${Date.now()}`, 'film.mp4'));
    const id = await createJob('rends un film ailleurs, puis rappelle sans la liste');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', [dehors]),
      rendu('rr-2', 'Film livré, promis.'),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain(
      deliverableNotVerifiedLine([
        { path: dehors, check: 'unresolved', detail: 'path_traversal_blocked' },
      ]),
    );
  });

  it('renvoyé, l’agent rappelle return_result SANS le fichier (il le retire) : la dette est soldée, completed', async () => {
    // Le renvoi dit « corrige-les, ou retire ceux que tu ne livres pas » :
    // retirer est une réponse légitime, et le nouveau return_result solde la dette.
    const dehors = normalizePath(join(tmpdir(), `hors-dossier-retire-${Date.now()}`, 'film.mp4'));
    const id = await createJob('rends un film ailleurs, puis retire la promesse');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film livré.', [dehors]),
      rendu('rr-2', 'Je ne livre finalement que le script.', []),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
  });
});

// Le cas qui a décidé du typage : la sortie par défaut de Remotion est `out/`
// DANS le projet (un `package.json` à sa racine). Typé comme un fichier ÉCRIT,
// le livrable serait rangé sous la ligne DU PROJET, dont la preuve n'ouvre
// jamais le fichier — le trou de #509, un dossier plus bas. Un livrable
// déclaré est un FICHIER, prouvé comme tel, où qu'il tombe.
describe('un livrable déclaré DANS un projet de code reste un fichier @cap:verifier-un-livrable/moteur', () => {
  const projet = (): string => join(ws, 'remotion');
  beforeAll(async () => {
    await mkdir(join(projet(), 'out'), { recursive: true });
    await writeFile(join(projet(), 'package.json'), '{"name":"film","private":true}');
  });

  it('absent : le run ÉCHOUE et la ligne nomme le fichier du projet et « not found »', async () => {
    const id = await createJob('rends le film dans le projet');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film rendu dans out/.', ['remotion/out/film-absent.mp4']),
      rendu('rr-2', 'Film rendu, relancé.', ['remotion/out/film-absent.mp4']),
    ]);

    await executeJob(id as JobId, makeDeps(client), testEnv);

    const abs = normalizePath(join(projet(), 'out', 'film-absent.mp4'));
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain('Film rendu, relancé.');
    expect(row.result).toContain(`${abs}: exists (${abs} not found)`);
    const states = await statesOf(id);
    expect(states.map((s) => [s.deliverableType, s.canonicalKey, s.declared])).toEqual([
      ['document', keyOf(abs), true],
    ]);
  });

  it('présent, en-tête MP4 valide : completed, et la preuve a lu LE FICHIER', async () => {
    await writeFile(join(projet(), 'out', 'film.mp4'), mp4Bytes());
    const id = await createJob('rends le film valide dans le projet');
    const { client } = makeMockLlmClient([
      rendu('rr-1', 'Film rendu dans out/.', ['remotion/out/film.mp4']),
    ]);

    const out = await executeJob(id as JobId, makeDeps(client), testEnv);

    expect(out.status).toBe('completed');
    const abs = normalizePath(join(projet(), 'out', 'film.mp4'));
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    const states = await statesOf(id);
    expect(states.map((s) => [s.deliverableType, s.canonicalKey, s.decisionStatus])).toEqual([
      ['document', keyOf(abs), 'green'],
    ]);
    const runs = await runsOf(id);
    expect(runs.map((r) => [r.canonicalKey, r.command, r.verdict])).toEqual([
      [keyOf(abs), 'exists', 'green'],
      [keyOf(abs), 'not-empty', 'green'],
      [keyOf(abs), 'well-formed:mp4', 'green'],
    ]);
  });
});

describe('SANS livrable déclaré, rien ne change @cap:verifier-un-livrable/moteur', () => {
  it('une preuve rouge NON déclarée reste observée : réparation, puis completed quand même', async () => {
    const id = await createJob('écris une note');
    const { client, prompts } = makeMockLlmClient([
      {
        text: 'Note écrite.',
        toolCalls: [
          {
            toolCallId: 'fw-1',
            toolName: 'file_write',
            args: { path: 'notes/sans-titre.md', content: 'pas de titre\n', create_dirs: true },
          },
          { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      rendu('rr-2', 'Note écrite, toujours sans titre.'),
    ]);

    const out = await executeJob(id as JobId, makeDeps(client), testEnv);

    // Le tour de réparation de #375 a bien eu lieu — le comportement d'avant.
    expect(prompts).toHaveLength(2);
    expect(out.status).toBe('completed');
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.result).not.toContain('[stopped:');
    const states = await statesOf(id);
    expect(
      states.map((s) => [s.deliverableType, s.declared, s.decisionStatus, s.redStreak]),
    ).toEqual([['document', false, 'red', 1]]);
    const runs = await runsOf(id);
    expect(runs.at(-1)).toMatchObject({ command: 'well-formed:markdown', verdict: 'red' });
  });
});

describe('la porte de finalisation, pour toute porte qui l’appelle @cap:verifier-un-livrable/moteur', () => {
  it('un texte déjà publié reste, SUIVI de la ligne ; la ligne part vers le canal à outil', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '42',
        task: 'publie le film',
        status: 'processing',
        result: 'Publié : le film est dans ton dossier.',
      })
      .returning({ id: agentJobs.id });
    if (!job) throw new Error('job insert failed');
    const abs = normalizePath(join(ws, 'publie.mp4'));
    await db.insert(jobDeliverableVerificationState).values({
      jobId: job.id,
      deliverableType: 'document',
      canonicalKey: keyOf(abs),
      displayPathSnapshot: abs,
      dirtyGeneration: 1,
      decisionStatus: 'dirty',
      declared: true,
    });
    const prepared: Array<{ channel: string; chatId: string; payload: string }> = [];

    const outcome = await finalizeJobSuccess(
      db as unknown as Parameters<typeof finalizeJobSuccess>[0],
      {
        jobId: job.id,
        result: '',
        resultKind: 'prose',
        // Une porte qui ne sait pas rouvrir son job : la garde joue quand même.
        repairTurn: 'unsupported',
        noticeTarget: { channel: 'telegram', chatId: '42' },
      },
      {
        prepareDelivery: async (_tx, d) => {
          prepared.push({ channel: d.channel, chatId: d.chatId, payload: d.payload });
        },
      },
    );

    expect(outcome.kind).toBe('failed');
    const line = deliverableNotVerifiedLine([
      { path: abs, check: 'exists', detail: `${abs} not found` },
    ]);
    const row = await jobRow(job.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toBe(`Publié : le film est dans ton dossier.

${line}`);
    expect(prepared).toEqual([{ channel: 'telegram', chatId: '42', payload: line }]);
  });
});
