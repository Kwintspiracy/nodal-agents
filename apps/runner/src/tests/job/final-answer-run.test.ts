// final-answer-run.test.ts — le `result` d'un job est la réponse qu'il donne
// quand il FINIT (#1083), par le vrai `executeJob`.
//
// Les trois occurrences du 14/11, rejouées : un agent délégué écrit une phrase
// en travaillant (« le PDF fait 2 pages, je resserre et je relance le rendu »),
// travaille encore, puis finit par `return_result` seul — le parent recevait la
// phrase ; un agent délégué rend un rapport complet, la preuve d'un livrable
// échoue, et la réponse du tour de réparation REMPLAÇAIT le rapport.
//
// Ce qui est affirmé : la ligne `agent_jobs.result`, le résultat que rend
// `executeJob` (ce que reçoit un parent, ce que lisent l'annonce et l'écran),
// et le CORPS de la requête que le modèle de l'agent qui délègue reçoit au tour
// suivant — jamais un nombre d'appels.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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
  agentAssignments,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  entities,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';

vi.setConfig({ testTimeout: 30_000 });

// ─── Interception du LLM ────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => void (active = c),
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('final-answer-run.test: no active LLM client set');
      return active;
    },
  };
});

// L'envoi Telegram, seul point remplacé pour le job de chat (comme
// delegation-subtree.test.ts) : la liste blanche reste calculée depuis la base.
const envois: Array<{ chatId: string; text: string }> = [];
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: () => ({
      ...actual.telegramAdapter,
      sendText: async (_creds: unknown, chatId: string, text: string) => {
        envois.push({ chatId, text });
        return { messageId: `mock-${envois.length}` };
      },
    }),
  };
});

interface MockTurn {
  text?: string;
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
}

/** Le modèle simulé, et le CORPS de chaque requête reçue, dans l'ordre. */
function makeMockLlmClient(responses: MockTurn[]): {
  client: RunnerDeps['llmClient'];
  prompts: string[];
} {
  let i = 0;
  const prompts: string[] = [];
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (r.text) content.push({ type: 'text', text: r.text });
      (r.toolCalls ?? []).forEach((tc, k) =>
        content.push({
          type: 'tool-call',
          toolCallId: `call-${i}-${k}-${Math.random().toString(36).slice(2, 8)}`,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        }),
      );
      const isTools = (r.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isTools
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
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
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
  PORT: 3095,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3095',
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

// ─── État ───────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** Le spécialiste qui écrit le document. */
let worker: string;
/** Son outil de délégation, chez l'orchestrateur (l'agent semé). */
let assignWorker: string;
/** Un agent de chat : un jeton de bot, donc l'outil d'envoi. */
let chatAgent: string;
/** Son outil de délégation, chez l'orchestrateur : un délégué qui PEUT envoyer. */
let assignChatter: string;
let ws: string;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-final-answer-')));

  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));

  const insertAgent = async (name: string, extra: Record<string, unknown>) => {
    const [row] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name,
        slug: `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        personality: `You are ${name}.`,
        llmKeyId: seed.llmKeyId,
        active: true,
        role: 'agent',
        ...extra,
      } as never)
      .returning({ id: agents.id, slug: agents.slug });
    if (!row) throw new Error(`seed agent failed: ${name}`);
    return row;
  };
  const w = await insertAgent('worker', {});
  worker = w.id;
  assignWorker = `assign_${w.slug.replace(/-/g, '_')}`;
  const c = await insertAgent('chatter', { telegramBotToken: 'bot-de-test' });
  chatAgent = c.id;
  assignChatter = `assign_${c.slug.replace(/-/g, '_')}`;

  await db.insert(agentAssignments).values([
    { orchestratorId: seed.agentId, subAgentId: worker, entityId: seed.entityId },
    { orchestratorId: seed.agentId, subAgentId: chatAgent, entityId: seed.entityId },
  ] as never);

  // `file_write`, et un dossier : le travail que la narration précède.
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Files ${Date.now()}`,
      slug: `files-final-answer-${Date.now()}`,
      content: 'write files',
      requiredBuiltins: ['file_write'],
    })
    .returning();
  if (!skill) throw new Error('skill insert failed');
  for (const agentId of [worker, chatAgent]) {
    await db
      .insert(agentSkillAssignments)
      .values({ entityId: seed.entityId, agentId, skillId: skill.id });
    await db
      .insert(agentWorkspaces)
      .values({ agentId, entityId: seed.entityId, label: 'ws', path: ws, position: 0 });
  }

  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: chatAgent,
    chatId: '4242',
    role: 'owner',
    status: 'active',
  } as never);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  envois.length = 0;
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

async function insertJob(values: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'Prépare le document d’une page, prêt à imprimer',
      channel: 'api',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function rowOf(jobId: string) {
  const [row] = await db
    .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

async function childOf(parentId: string) {
  const [row] = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
    })
    .from(agentJobs)
    .where(eq(agentJobs.parentJobId, parentId));
  return row!;
}

// ─── Les tours ──────────────────────────────────────────────────────────────

const NARRATION =
  'The PDF came out at 2 pages, so the layout does not yet meet the one-page requirement. ' +
  'I’ll tighten the text and spacing, then re-render and re-check.';
const REASON =
  'One-page A4 document rendered and checked: page_count 1, page size 594.96 x 841.92 pt.';
const FINAL = 'Done: the document fits on one A4 page (checked: page_count 1), saved as doc.html.';
const REPORT =
  'The document is done: one A4 page, doc.html in your folder, page count measured at 1. ' +
  'Sources: NIST CODATA 2022.';
const NOTE = 'The repair is in place: I closed the <div> at line 3. Only the HTML changed.';

const GOOD = '<html><body><div><p>One page.</p></div></body></html>';
const BROKEN = '<html><body>\n<div>\n<p>One page.</p>\n</body></html>';

const write = (path: string, content: string) => ({
  toolName: 'file_write',
  args: { path, content },
});
const done = (args: Record<string, unknown> = {}) => ({
  toolName: 'return_result',
  args: { status: 'success', ...args },
});
const delegate = (): MockTurn => ({
  toolCalls: [{ toolName: assignWorker, args: { task: 'Make the one-page document' } }],
});
const rootEnds: MockTurn = { text: 'Synthèse remise.', toolCalls: [done()] };

/** La requête que l'orchestrateur envoie à son modèle APRÈS la délégation. */
const resumeOf = (prompts: string[]): string => prompts.at(-1)!;

// ─── Forme B : la narration périmée ─────────────────────────────────────────

describe('ce que reçoit l’agent qui délègue : la réponse de la FIN (#1083, forme B) @cap:organiser-equipe/moteur', () => {
  it('texte, travail, puis return_result(success, reason) seul : le parent reçoit le reason, jamais la narration', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: NARRATION, toolCalls: [write('b1.html', GOOD)] },
      { toolCalls: [write('b1.html', GOOD)] },
      { toolCalls: [write('b1.html', GOOD)] },
      { toolCalls: [done({ reason: REASON })] },
      rootEnds,
    ]);

    const outcome = await executeJob(rootId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(REASON);
    // Le corps de la requête de l'orchestrateur, au tour qui suit la délégation.
    expect(resumeOf(prompts)).toContain(REASON);
    expect(resumeOf(prompts)).not.toContain('I’ll tighten the text');
    // Le travail a bien eu lieu : le fichier est sur le disque.
    expect(await readFile(join(ws, 'b1.html'), 'utf8')).toBe(GOOD);
  });

  it('sans reason : UN rappel demande la réponse écrite, et c’est elle que le parent reçoit', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: NARRATION, toolCalls: [write('b2.html', GOOD)] },
      { toolCalls: [write('b2.html', GOOD)] },
      { toolCalls: [done()] },
      { text: FINAL },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(FINAL);
    // Le spécialiste a reçu le rappel AVANT d'écrire sa réponse.
    expect(prompts[4]).toContain('aucun texte écrit depuis ton dernier appel');
    expect(resumeOf(prompts)).toContain(FINAL);
    expect(resumeOf(prompts)).not.toContain('I’ll tighten the text');
  });

  it('sans reason et sans réponse après le rappel : échec franc, et la narration ne part pas', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: NARRATION, toolCalls: [write('b3.html', GOOD)] },
      { toolCalls: [write('b3.html', GOOD)] },
      { toolCalls: [done()] },
      { toolCalls: [done()] },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.status).toBe('failed');
    expect(child.error).toBe('empty_deliverable');
    expect(resumeOf(prompts)).toContain('empty_deliverable');
    expect(resumeOf(prompts)).not.toContain('I’ll tighten the text');
  });
});

// ─── Le rapport écrit avec un appel de son propre pas (relecture, P1) ──────
//
// Relu par l'orchestrateur sur les 2 217 jobs de l'installation du
// propriétaire : 81 jobs écrivent leur rapport complet dans le même pas qu'un
// appel (le verdict d'une revue, une mémoire, un vote, un fichier…) et ne font
// plus rien après, puis finissent par `return_result` seul. La première règle
// les privait de leur rapport.

describe('un rapport écrit AVEC un appel de son pas reste la réponse @cap:organiser-equipe/moteur', () => {
  it('délégué : rapport + appel, puis return_result seul : le parent reçoit le rapport', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: REPORT, toolCalls: [write('r1.html', GOOD)] },
      { toolCalls: [done()] },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(REPORT);
    expect(resumeOf(prompts)).toContain('Sources: NIST CODATA 2022.');
    // Aucun rappel : le rapport tenait.
    expect(prompts.join('')).not.toContain('aucun texte écrit depuis ton dernier appel');
  });

  it('tête : rapport + appel, puis return_result seul : le résultat est le rapport', async () => {
    const jobId = await insertJob({ agentId: worker });
    const { client, prompts } = makeMockLlmClient([
      { text: REPORT, toolCalls: [write('r2.html', GOOD)] },
      { toolCalls: [done()] },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect((await rowOf(jobId)).result).toBe(REPORT);
    expect(outcome.result).toBe(REPORT);
    expect(prompts).toHaveLength(2);
  });

  it('le reason d’un return_result ULTÉRIEUR suit le rapport, sans un mot du runner', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: REPORT, toolCalls: [write('r3.html', GOOD)] },
      { toolCalls: [done({ reason: REASON })] },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.result).toBe(`${REPORT}\n\n${REASON}`);
    const resume = resumeOf(prompts);
    expect(resume.indexOf('Sources: NIST')).toBeLessThan(resume.indexOf('page_count 1, page size'));
  });

  it('un rapport puis un pas ULTÉRIEUR qui agit, puis return_result seul : le rappel dit pourquoi, et la réponse réécrite part', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { text: REPORT, toolCalls: [write('r4.html', GOOD)] },
      { toolCalls: [write('r4-check.html', GOOD)] },
      { toolCalls: [done()] },
      { text: FINAL },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    // Le coût : UN tour de plus, et le rappel dit au modèle pourquoi son texte
    // n'est pas repris et qu'il doit le redire en entier, pas y renvoyer.
    expect(prompts[4]).toContain('n’est pas repris, parce qu’il ne connaissait pas la suite');
    expect(prompts[4]).toContain('pas de « voir plus haut »');
    const child = await childOf(rootId);
    expect(child.result).toBe(FINAL);
    expect(resumeOf(prompts)).toContain(FINAL);
  });
});

// ─── Forme A : la note de réparation ────────────────────────────────────────

describe('un tour de réparation ne remplace pas la réponse (#1083, forme A) @cap:verifier-un-livrable/moteur', () => {
  it('rapport, preuve rouge, réparation finie en TEXTE : le parent reçoit le rapport PUIS la note', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { toolCalls: [write('a1.html', BROKEN)] },
      { text: REPORT, toolCalls: [done({ deliverables: ['a1.html'] })] },
      // Le tour de réparation : il répare, puis répond sans appel d'outil.
      { toolCalls: [write('a1.html', GOOD)] },
      { text: NOTE },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    // La réparation a bien eu lieu, sur la preuve rouge.
    expect(prompts[3]).toContain('The proof of your deliverable failed');
    expect(prompts[3]).toContain('The answer you already gave stands');
    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(`${REPORT}\n\n${NOTE}`);
    const resume = resumeOf(prompts);
    expect(resume).toContain('Sources: NIST CODATA 2022.');
    expect(resume).toContain('I closed the <div> at line 3.');
    expect(resume.indexOf('Sources: NIST')).toBeLessThan(resume.indexOf('I closed the <div>'));
  });

  it('DEUX réparations finies par return_result : le rapport, puis chaque note, dans l’ordre', async () => {
    await db.update(entities).set({ proofRepairAttempts: 2 }).where(eq(entities.id, seed.entityId));
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      delegate(),
      { toolCalls: [write('a2.html', BROKEN)] },
      { text: REPORT, toolCalls: [done({ deliverables: ['a2.html'] })] },
      // Réparation 1 : toujours cassé, une note dans le `reason`.
      { toolCalls: [write('a2.html', `${BROKEN}\n<div>`)] },
      { toolCalls: [done({ deliverables: ['a2.html'], reason: 'First repair: moved a tag.' })] },
      // Réparation 2 : réparé, une note écrite avec le signal.
      { toolCalls: [write('a2.html', GOOD)] },
      {
        text: 'Second repair: every div is closed now.',
        toolCalls: [done({ deliverables: ['a2.html'] })],
      },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(
      `${REPORT}\n\nFirst repair: moved a tag.\n\nSecond repair: every div is closed now.`,
    );
    const resume = resumeOf(prompts);
    expect(resume).toContain('Sources: NIST CODATA 2022.');
    expect(resume.indexOf('Sources: NIST')).toBeLessThan(resume.indexOf('First repair'));
    expect(resume.indexOf('First repair')).toBeLessThan(resume.indexOf('Second repair'));
  });
});

// ─── Un job de tête : ce que la personne reçoit ─────────────────────────────

describe('un job de TÊTE rend la même réponse à la personne (#1083) @cap:parler-a-un-agent/moteur', () => {
  it('forme A : le résultat du job est le rapport puis la note, une seule fois chacun', async () => {
    const jobId = await insertJob({ agentId: worker });
    const { client } = makeMockLlmClient([
      { toolCalls: [write('h1.html', BROKEN)] },
      { text: REPORT, toolCalls: [done({ deliverables: ['h1.html'] })] },
      { toolCalls: [write('h1.html', GOOD)] },
      { text: NOTE, toolCalls: [done({ deliverables: ['h1.html'] })] },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    const row = await rowOf(jobId);
    expect(row.result).toBe(`${REPORT}\n\n${NOTE}`);
    expect(outcome.result).toBe(row.result);
  });

  it('forme A sur une réponse PUBLIÉE (dashboard_publish) : la note s’ajoute à ce qui est publié', async () => {
    const jobId = await insertJob({ agentId: worker });
    const { client } = makeMockLlmClient([
      { toolCalls: [write('h3.html', BROKEN)] },
      {
        toolCalls: [
          { toolName: 'dashboard_publish', args: { text: REPORT } },
          done({ deliverables: ['h3.html'] }),
        ],
      },
      { toolCalls: [write('h3.html', GOOD)] },
      { text: NOTE },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect((await rowOf(jobId)).result).toBe(`${REPORT}\n\n${NOTE}`);
    expect(outcome.result).toBe(`${REPORT}\n\n${NOTE}`);
  });

  it('un texte PUBLIÉ puis un texte plus tard et return_result : le texte publié reste, comme sur main', async () => {
    const jobId = await insertJob({ agentId: worker });
    const { client } = makeMockLlmClient([
      { toolCalls: [{ toolName: 'dashboard_publish', args: { text: REPORT } }] },
      { text: 'Published the report on the dashboard.', toolCalls: [done()] },
    ]);

    await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect((await rowOf(jobId)).result).toBe(REPORT);
  });

  it('forme B : le résultat du job est le reason de la fin, pas la narration', async () => {
    const jobId = await insertJob({ agentId: worker });
    const { client } = makeMockLlmClient([
      { text: NARRATION, toolCalls: [write('h2.html', GOOD)] },
      { toolCalls: [write('h2.html', GOOD)] },
      { toolCalls: [done({ reason: REASON })] },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    expect((await rowOf(jobId)).result).toBe(REASON);
  });
});

// ─── Les formes qui marchaient : inchangées ─────────────────────────────────

describe('les fins qui marchaient restent les mêmes (#1083) @cap:organiser-equipe/moteur', () => {
  const childResultFor = async (turns: MockTurn[]) => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([delegate(), ...turns, rootEnds]);
    await executeJob(rootId as JobId, makeDeps(client), testEnv);
    return { child: await childOf(rootId), resume: resumeOf(prompts) };
  };

  it('un rapport et return_result dans le même pas, même avec un reason', async () => {
    const { child, resume } = await childResultFor([
      { toolCalls: [write('u1.html', GOOD)] },
      { text: REPORT, toolCalls: [done({ reason: 'Report written.' })] },
    ]);
    expect(child.result).toBe(REPORT);
    expect(resume).toContain('Sources: NIST CODATA 2022.');
  });

  it('un rapport, puis return_result SEUL au pas suivant, sans travail entre', async () => {
    // Le signal du rapport est renvoyé (un chemin de `deliverables` hors des
    // dossiers, #509) ; l'agent le refait seul, sans rien écrire ni faire.
    const dehors = join(tmpdir(), `hors-dossier-${Date.now()}`, 'u2.html');
    const { child, resume } = await childResultFor([
      { toolCalls: [write('u2.html', GOOD)] },
      { text: REPORT, toolCalls: [done({ deliverables: [dehors] })] },
      { toolCalls: [done({ deliverables: ['u2.html'] })] },
    ]);
    expect(child.status).toBe('completed');
    expect(child.result).toBe(REPORT);
    expect(resume).toContain('Sources: NIST CODATA 2022.');
  });

  it('une réponse sans appel d’outil', async () => {
    const { child, resume } = await childResultFor([
      { text: NARRATION, toolCalls: [write('u3.html', GOOD)] },
      { text: REPORT },
    ]);
    expect(child.result).toBe(REPORT);
    expect(resume).toContain('Sources: NIST CODATA 2022.');
    expect(resume).not.toContain('I’ll tighten the text');
  });

  it('un blocage rend sa raison', async () => {
    const { child, resume } = await childResultFor([
      { text: NARRATION, toolCalls: [write('u5.html', GOOD)] },
      {
        toolCalls: [
          { toolName: 'return_result', args: { status: 'blocked', reason: 'The printer is off.' } },
        ],
      },
    ]);
    expect(child.status).toBe('failed');
    expect(child.result).toBe('The printer is off.');
    expect(resume).toContain('The printer is off.');
    expect(resume).not.toContain('I’ll tighten the text');
  });

  it('un job de chat dont la réponse part par l’outil d’envoi : le reason ne devient pas le résultat', async () => {
    const jobId = await insertJob({
      agentId: chatAgent,
      channel: 'telegram',
      chatId: '4242',
      chatChannel: 'telegram',
    });
    const { client } = makeMockLlmClient([
      {
        toolCalls: [
          { toolName: 'telegram_send_message', args: { text: REPORT } },
          done({ reason: 'Sent the answer to the user.' }),
        ],
      },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    expect(envois.map((e) => e.text)).toEqual([REPORT]);
    // Comme avant : aucun texte écrit, rien dans `result` — la relecture du fil
    // lit la réponse dans l'envoi (#1075), pas dans une phrase de signal.
    expect((await rowOf(jobId)).result ?? '').toBe('');
  });
});

describe('les autres fins lisent la même réponse (#1083) @cap:verifier-un-livrable/moteur', () => {
  it('un job de chat qui a narré avant de travailler : la narration ne devient pas le résultat', async () => {
    const jobId = await insertJob({
      agentId: chatAgent,
      channel: 'telegram',
      chatId: '4242',
      chatChannel: 'telegram',
    });
    const { client } = makeMockLlmClient([
      { text: 'Je regarde, une seconde.', toolCalls: [write('c2.html', GOOD)] },
      { toolCalls: [write('c2.html', GOOD)] },
      {
        toolCalls: [
          { toolName: 'telegram_send_message', args: { text: REPORT } },
          done({ reason: 'Sent the answer to the user.' }),
        ],
      },
    ]);

    await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(envois.map((e) => e.text)).toEqual([REPORT]);
    // Avant : « Je regarde, une seconde. » devenait le résultat, et la relecture
    // du fil le rejouait à la place de ce qui était parti.
    expect((await rowOf(jobId)).result ?? '').toBe('');
  });

  it('un livrable promis introuvable : l’échec porte la réponse de la fin, jamais la narration', async () => {
    const dehors = join(tmpdir(), `hors-dossier-${Date.now()}`, 'd1.html');
    const jobId = await insertJob({ agentId: worker });
    const { client } = makeMockLlmClient([
      { text: NARRATION, toolCalls: [write('d1.html', GOOD)] },
      { toolCalls: [write('d1.html', GOOD)] },
      { toolCalls: [done({ deliverables: [dehors], reason: REASON })] },
      { toolCalls: [done({ deliverables: [dehors], reason: REASON })] },
    ]);

    await executeJob(jobId as JobId, makeDeps(client), testEnv);

    const row = await rowOf(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('deliverable_not_verified');
    expect(row.result).toContain(REASON);
    expect(row.result).toContain('[stopped: declared deliverable not verified');
    expect(row.result).not.toContain('I’ll tighten the text');
  });
});

// ─── Un envoi DIT, il ne travaille pas (relecture, P2) ──────────────────────
//
// Relu par l'orchestrateur sur les 2 217 jobs de l'installation du
// propriétaire : 116 jobs qui avaient appelé un outil de livraison voyaient leur
// résultat VIDÉ (86 Telegram, 16 cron, 13 MCP, 1 Discord) — l'envoi d'un pas
// ultérieur périmait le texte. Le résultat que lisent `get_task`, la page des
// runs et les listes était vide, sans rappel ni échec.

const sendTo4242 = (text: string) => ({
  toolName: 'telegram_send_message',
  args: { text, chatId: '4242' },
});

describe('un envoi ne périme pas le texte qui le précède (#1083, P2) @cap:parler-par-canal-externe/moteur', () => {
  it('chat : le texte seul, le rappel de livraison, puis envoi + fin : le résultat est le texte', async () => {
    const jobId = await insertJob({
      agentId: chatAgent,
      channel: 'telegram',
      chatId: '4242',
      chatChannel: 'telegram',
    });
    const { client } = makeMockLlmClient([
      { text: REPORT },
      { toolCalls: [{ toolName: 'telegram_send_message', args: { text: REPORT } }, done()] },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    expect(envois.map((e) => e.text)).toEqual([REPORT]);
    expect((await rowOf(jobId)).result).toBe(REPORT);
  });

  it('tête qui répond par son RÉSULTAT (lu comme get_task le lit) : texte, puis un envoi seul, puis fin', async () => {
    const jobId = await insertJob({ agentId: chatAgent, channel: 'mcp' });
    const { client } = makeMockLlmClient([
      { text: REPORT, toolCalls: [write('s2.html', GOOD)] },
      { toolCalls: [sendTo4242('The report is ready.')] },
      { toolCalls: [done()] },
    ]);

    const outcome = await executeJob(jobId as JobId, makeDeps(client), testEnv);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(envois.map((e) => e.text)).toEqual(['The report is ready.']);
    expect((await rowOf(jobId)).result).toBe(REPORT);
    expect(outcome.result).toContain(REPORT);
  });

  it('délégué : texte, puis un envoi seul, puis fin : le parent reçoit le texte', async () => {
    const rootId = await insertJob();
    const { client, prompts } = makeMockLlmClient([
      { toolCalls: [{ toolName: assignChatter, args: { task: 'Make the one-page document' } }] },
      { text: REPORT, toolCalls: [write('s3.html', GOOD)] },
      { toolCalls: [sendTo4242('The report is ready.')] },
      { toolCalls: [done()] },
      rootEnds,
    ]);

    await executeJob(rootId as JobId, makeDeps(client), testEnv);

    const child = await childOf(rootId);
    expect(child.status).toBe('completed');
    expect(child.result).toContain(REPORT);
    expect(resumeOf(prompts)).toContain('Sources: NIST CODATA 2022.');
  });

  it('forme B avec un envoi au milieu du travail, sur un job qui répond par son résultat : le reason', async () => {
    const jobId = await insertJob({ agentId: chatAgent, channel: 'mcp' });
    const { client } = makeMockLlmClient([
      { text: NARRATION, toolCalls: [write('s4.html', GOOD)] },
      { toolCalls: [write('s4.html', GOOD)] },
      { toolCalls: [sendTo4242('Preview sent.')] },
      { toolCalls: [done({ reason: REASON })] },
    ]);

    await executeJob(jobId as JobId, makeDeps(client), testEnv);

    // La livraison de ce job est son résultat : l'envoi en passant ne fait pas
    // de lui un job « qui répond par un envoi », et son reason n'est pas jeté.
    expect((await rowOf(jobId)).result).toBe(REASON);
  });
});
