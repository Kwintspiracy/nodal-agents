// router/review-verdict.test.ts — le verdict de revue, lu sur les VRAIES lignes
// `tool_calls` (issue #124).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, toolCalls, users, entities } from '@nodal-agents/db';
import {
  readDeliveredReviewVerdict,
  readFinalReviewVerdict,
  parseReviewVerdictOutput,
} from '../../router/review-verdict';
import { OrchestrationError } from '../../errors';
import type { JobId } from '../../types';

let db: TestDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
});

/** La sortie EXACTE que `review_verdict` écrit quand il a validé un verdict. */
const VERDICT_OUTPUT = {
  ok: true,
  verdict: 'request_changes',
  summary: 'Relu le diff de la PR : trois fichiers lus, la suite du paquet jouée.',
  findings: [
    {
      file: 'packages/llm/src/retry.ts',
      line: 99,
      issue: 'La liste de mots-clés classe un 429 passager en facturation.',
      severity: 'blocker',
    },
    {
      file: 'apps/web/src/components/Thread.tsx',
      issue: 'Le libellé du bouton n’est pas dans la langue du propriétaire.',
      severity: 'minor',
    },
  ],
  counts: { blocker: 1, major: 0, minor: 1 },
};

async function seedJob(): Promise<{ jobId: string; entityId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `rv-${suffix}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-rv-${suffix}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Reviewer',
      slug: `reviewer-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: agent!.id,
      channel: 'internal',
      task: 'review task',
      status: 'completed',
    })
    .returning();
  return { jobId: job!.id, entityId: entity!.id };
}

/**
 * Une ligne `tool_calls` DANS LA FORME DE PRODUCTION : `executeTool`
 * (`packages/tools/src/execute.ts`) écrit `JSON.stringify(output)`, où `output`
 * est la valeur rendue par `execute()` de l'outil.
 */
async function recordToolRow(
  jobId: string,
  entityId: string,
  toolName: string,
  output: unknown,
  createdAt: Date,
): Promise<void> {
  await db.insert(toolCalls).values({
    entityId,
    jobId,
    toolName,
    toolInput: {},
    toolOutput: typeof output === 'string' ? output : JSON.stringify(output),
    createdAt,
  });
}

async function recordVerdictRow(
  jobId: string,
  entityId: string,
  output: unknown,
  createdAt: Date,
): Promise<void> {
  await recordToolRow(jobId, entityId, 'review_verdict', output, createdAt);
}

describe('parseReviewVerdictOutput @cap:organiser-equipe/moteur', () => {
  it('rend le verdict validé par l’outil, constats compris', () => {
    const parsed = parseReviewVerdictOutput(JSON.stringify(VERDICT_OUTPUT));
    expect(parsed?.verdict).toBe('request_changes');
    expect(parsed?.summary).toBe(VERDICT_OUTPUT.summary);
    expect(parsed?.findings).toHaveLength(2);
    expect(parsed?.findings[0]?.file).toBe('packages/llm/src/retry.ts');
    expect(parsed?.findings[0]?.severity).toBe('blocker');
    expect(parsed?.counts).toEqual({ blocker: 1, major: 0, minor: 1 });
  });

  it('rend null sur un appel REFUSÉ par le schéma de l’outil', () => {
    const refused = JSON.stringify({
      outcome: 'error',
      error: { message: 'request_changes requires at least one finding' },
    });
    expect(parseReviewVerdictOutput(refused)).toBeNull();
  });

  it('rend null sur une sortie illisible ou vide', () => {
    expect(parseReviewVerdictOutput('pas du json')).toBeNull();
    expect(parseReviewVerdictOutput(null)).toBeNull();
  });

  it('LÈVE sur une sortie qui s’annonce réussie sans respecter le contrat', () => {
    // Taire ce cas livrerait au parent un verdict tronqué — un verdict sans
    // constats se lit comme « rien à signaler » (invariant #4).
    const broken = JSON.stringify({ ok: true, verdict: 'request_changes' });
    expect(() => parseReviewVerdictOutput(broken)).toThrow(OrchestrationError);
    expect(() => parseReviewVerdictOutput(broken)).toThrow(/review_verdict_malformed/);
  });
});

describe('readDeliveredReviewVerdict @cap:organiser-equipe/moteur', () => {
  it('lit le verdict sur la ligne tool_calls du job', async () => {
    const { jobId, entityId } = await seedJob();
    await recordVerdictRow(jobId, entityId, VERDICT_OUTPUT, new Date('2026-09-16T10:00:00Z'));

    const verdict = await readDeliveredReviewVerdict(db, jobId as JobId);

    expect(verdict?.verdict).toBe('request_changes');
    expect(verdict?.findings).toHaveLength(2);
    expect(verdict?.counts.blocker).toBe(1);
  });

  it('rend null quand le job n’a jamais appelé l’outil', async () => {
    const { jobId } = await seedJob();
    expect(await readDeliveredReviewVerdict(db, jobId as JobId)).toBeNull();
  });

  it('c’est le DERNIER appel qui fait foi', async () => {
    const { jobId, entityId } = await seedJob();
    await recordVerdictRow(jobId, entityId, VERDICT_OUTPUT, new Date('2026-09-16T10:00:00Z'));
    await recordVerdictRow(
      jobId,
      entityId,
      {
        ...VERDICT_OUTPUT,
        verdict: 'approve',
        findings: [],
        counts: { blocker: 0, major: 0, minor: 0 },
      },
      new Date('2026-09-16T10:05:00Z'),
    );

    const verdict = await readDeliveredReviewVerdict(db, jobId as JobId);

    expect(verdict?.verdict).toBe('approve');
    expect(verdict?.findings).toEqual([]);
  });

  it('un dernier appel REFUSÉ ne livre rien, même après un appel réussi', async () => {
    // Le relecteur a remis en cause son propre verdict : remonter au précédent
    // livrerait un verdict qu’il a lui-même retiré.
    const { jobId, entityId } = await seedJob();
    await recordVerdictRow(jobId, entityId, VERDICT_OUTPUT, new Date('2026-09-16T10:00:00Z'));
    await recordVerdictRow(
      jobId,
      entityId,
      { outcome: 'error', error: { message: 'approve cannot carry blocker findings' } },
      new Date('2026-09-16T10:05:00Z'),
    );

    expect(await readDeliveredReviewVerdict(db, jobId as JobId)).toBeNull();
  });
});

describe('readFinalReviewVerdict @cap:organiser-equipe/moteur', () => {
  it('rend le verdict quand il est le DERNIER appel d’outil du job', async () => {
    // Le tour final d'un relecteur est « verdict puis return_result », et
    // `return_result` n'écrit aucune ligne : le verdict reste bien le dernier.
    const { jobId, entityId } = await seedJob();
    await recordToolRow(
      jobId,
      entityId,
      'read_file',
      { ok: true },
      new Date('2026-09-16T10:00:00Z'),
    );
    await recordVerdictRow(jobId, entityId, VERDICT_OUTPUT, new Date('2026-09-16T10:05:00Z'));

    expect((await readFinalReviewVerdict(db, jobId as JobId))?.verdict).toBe('request_changes');
  });

  it('rend null quand un autre outil a tourné APRÈS le verdict', async () => {
    const { jobId, entityId } = await seedJob();
    await recordVerdictRow(jobId, entityId, VERDICT_OUTPUT, new Date('2026-09-16T10:00:00Z'));
    await recordToolRow(
      jobId,
      entityId,
      'tavily_search',
      { ok: true, results: [] },
      new Date('2026-09-16T10:05:00Z'),
    );

    expect(await readFinalReviewVerdict(db, jobId as JobId)).toBeNull();
    // Le verdict, lui, reste le verdict de ce job pour son parent.
    expect((await readDeliveredReviewVerdict(db, jobId as JobId))?.verdict).toBe('request_changes');
  });
});
