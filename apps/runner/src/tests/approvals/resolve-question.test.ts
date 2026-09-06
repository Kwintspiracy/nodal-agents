// resolve-question.test.ts — répondre à une QUESTION (P10a).
//
// La règle que ce fichier protège : la réponse doit être l'une des options que
// l'agent a proposées, LUES SUR LA LIGNE — jamais celle que l'appelant
// affirme. L'agent relira cette chaîne comme le résultat de son outil ; une
// carte périmée, un bouton forgé ou une option retirée depuis ne doivent pas
// pouvoir lui faire dire n'importe quoi.
//
// Les assertions relisent la ligne `approval_requests` ET la ligne du job :
// un refus doit laisser les DEUX intacts, sinon le travail repartirait sans
// réponse.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let seed: { entityId: string; agentId: string; jobId: string };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'test',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 's',
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

function makeDeps(): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

const OPTIONS = ['The repo README', 'A new file in notes'];

async function insertQuestion(overrides: { toolInput?: unknown } = {}) {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'ask_user',
      toolInput: (overrides.toolInput ?? {
        question: 'Where should I write the summary?',
        options: OPTIONS,
      }) as Record<string, unknown>,
      toolCallId: 'call-q',
      kind: 'question',
      status: 'pending',
    })
    .returning();
  return row!;
}

async function readBack(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!;
}

async function jobStatus() {
  const [row] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, seed.jobId));
  return row?.status ?? null;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const minimal = await seedMinimal(db);
  seed = { entityId: minimal.entityId, agentId: minimal.agentId, jobId: minimal.jobId };
});

beforeEach(async () => {
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentJobs.id, seed.jobId));
});

describe('resolveApprovalDecision — une question', () => {
  it('approuve avec une option valide : la ligne porte la réponse, le job repart', async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'approve',
      answer: OPTIONS[1]!,
      resolvedBy: 'api',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toBe(OPTIONS[1]);

    const row = await readBack(approval.id);
    expect(row.status).toBe('approved');
    expect(row.answer).toBe(OPTIONS[1]);
    expect(await jobStatus()).toBe('pending');
  });

  it('la réponse est TRIMÉE avant comparaison — un espace de bouton ne doit pas refuser un choix légitime', async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'approve',
      answer: `  ${OPTIONS[0]}  `,
      resolvedBy: 'api',
    });

    expect(result.ok).toBe(true);
    expect((await readBack(approval.id)).answer).toBe(OPTIONS[0]);
  });

  it("une réponse HORS options est refusée, et rien n'a bougé", async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'approve',
      answer: 'Somewhere else entirely',
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'answer_not_an_option' });

    const row = await readBack(approval.id);
    expect(row.status).toBe('pending');
    expect(row.answer).toBeNull();
    expect(await jobStatus()).toBe('awaiting_approval');
  });

  it('approuver une question SANS réponse est refusé', async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'approve',
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'answer_not_an_option' });
    expect((await readBack(approval.id)).status).toBe('pending');
  });

  it('une ligne dont les options ne se lisent pas ne peut pas être répondue', async () => {
    const approval = await insertQuestion({ toolInput: { question: 'Which?', options: 'nope' } });

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'approve',
      answer: 'nope',
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'question_options_unreadable' });
    expect((await readBack(approval.id)).status).toBe('pending');
  });

  it('décliner une question la marque rejetée, garde la note, et laisse `answer` NULL', async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'reject',
      notes: 'None of these fits',
      resolvedBy: 'api',
    });

    expect(result.ok).toBe(true);

    const row = await readBack(approval.id);
    expect(row.status).toBe('rejected');
    expect(row.notes).toBe('None of these fits');
    expect(row.answer).toBeNull();
    expect(await jobStatus()).toBe('pending');
  });

  it("une réponse EN DÉCLINANT est refusée — décliner, ce n'est pas choisir", async () => {
    const approval = await insertQuestion();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval.id,
      decision: 'reject',
      answer: OPTIONS[0]!,
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'answer_not_expected' });
    expect((await readBack(approval.id)).status).toBe('pending');
  });
});

describe('resolveApprovalDecision — une approbation ordinaire', () => {
  it("refuse une réponse : elle n'a aucune liste où pointer", async () => {
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        status: 'pending',
      })
      .returning();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval!.id,
      decision: 'approve',
      answer: 'ls',
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'answer_not_expected' });
    expect((await readBack(approval!.id)).status).toBe('pending');
  });

  it('approuve sans réponse, exactement comme avant, et `answer` reste NULL', async () => {
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        status: 'pending',
      })
      .returning();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval!.id,
      decision: 'approve',
      resolvedBy: 'api',
    });

    expect(result.ok).toBe(true);
    const row = await readBack(approval!.id);
    expect(row.status).toBe('approved');
    expect(row.answer).toBeNull();
  });
});
