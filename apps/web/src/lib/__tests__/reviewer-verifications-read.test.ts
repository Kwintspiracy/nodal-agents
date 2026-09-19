// reviewer-verifications-read.test.ts — ce que la page d'un run dit des
// vérifications d'un relecteur, et de sa livraison (issue #59), sur une base
// réelle, par l'action que la page appelle.
//
// @cap:verifier-un-livrable/moteur
//
// Deux faits, tous deux décidés par le propriétaire le 19/09/2026 :
//
//  - les commandes d'un relecteur remontent dans la section Verification AVEC
//    leur origine — le rôle et le nom de qui les a lancées ;
//  - le récapitulatif de livraison porte le DERNIER verdict de relecture, que
//    l'écran pose à côté de « Delivered » (décision du 19/09 au soir).
//
// Aucun nom d'agent réel : le relecteur s'appelle ici « Second Pair Of Eyes ».

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, toolCalls, verificationRuns, eq } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let rootJobId: string;
let reviewerJobId: string;

const REVIEWER_NAME = 'Second Pair Of Eyes';
const REVIEW_SEQ = '55555555-5555-4555-8555-555555555555';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const actions = () => import('../actions.ts');

/** Le verdict, dans la forme EXACTE que `review_verdict` écrit. */
function verdictOutput(verdict: 'approve' | 'request_changes'): string {
  return JSON.stringify({
    ok: true,
    verdict,
    summary: 'Ran the browser scenarios against the delivered app.',
    findings:
      verdict === 'request_changes'
        ? [{ file: 'app.js', issue: 'The cart total is off by one.', severity: 'blocker' }]
        : [],
    counts:
      verdict === 'request_changes'
        ? { blocker: 1, major: 0, minor: 0 }
        : { blocker: 0, major: 0, minor: 0 },
  });
}

async function setVerdict(verdict: 'approve' | 'request_changes'): Promise<void> {
  await testDb.delete(toolCalls).where(eq(toolCalls.jobId, reviewerJobId));
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: reviewerJobId,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: verdictOutput(verdict),
    turn: 1,
  });
}

/** Le récapitulatif de livraison que l'action pose sous le run. */
async function deliveredSummary() {
  const { getSpaceConversationAction } = await actions();
  const r = await getSpaceConversationAction(rootJobId);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('the run is unreadable');
  const produced = r.data.feed.items.find((i) => i.kind === 'produced');
  if (produced === undefined || produced.kind !== 'produced')
    throw new Error('the run has no delivery summary');
  return produced.summary;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [reviewerAgent] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: REVIEWER_NAME,
      slug: `second-pair-${Date.now()}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();

  const [root] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Build the little web app',
      status: 'completed',
      result: 'Done.',
      completedAt: new Date('2026-09-19T10:00:00Z'),
    })
    .returning();
  rootJobId = root!.id;

  const [reviewer] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: reviewerAgent!.id,
      channel: 'internal',
      task: 'Review the little web app',
      status: 'completed',
      parentJobId: rootJobId,
    })
    .returning();
  reviewerJobId = reviewer!.id;

  // Le travail du run : une commande, pour que le fil le classe comme TRAVAIL
  // et pose son récapitulatif de livraison.
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: rootJobId,
    toolName: 'run_command',
    toolCallId: 'call-build',
    toolInput: { command: 'node --check app.js' },
    toolOutput: JSON.stringify({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    card: 'terminal',
    presented: { card: 'terminal', command: 'node --check app.js', exitCode: 0 },
    riskLevel: 'destructive',
    turn: 1,
  });

  // Les preuves du RELECTEUR, telles que le runner les écrit : rattachées au
  // job relu, avec leur origine.
  await testDb.insert(verificationRuns).values([
    {
      jobId: rootJobId,
      entityId: seed.entityId,
      deliverableType: 'other',
      canonicalKey: `review:${reviewerJobId}`,
      sequenceId: REVIEW_SEQ,
      commandRank: 1,
      command: 'npx playwright test tests/e2e/panier.spec.ts',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 9100,
      verdict: 'green',
      source: 'reviewer',
      sourceJobId: reviewerJobId,
    },
    {
      jobId: rootJobId,
      entityId: seed.entityId,
      deliverableType: 'other',
      canonicalKey: `review:${reviewerJobId}`,
      sequenceId: REVIEW_SEQ,
      commandRank: 2,
      command: 'npx playwright test tests/e2e/paiement.spec.ts',
      exitCode: 1,
      outcomeKind: 'exit',
      durationMs: 7300,
      verdict: 'red',
      source: 'reviewer',
      sourceJobId: reviewerJobId,
    },
  ]);
});

describe('la section Verification montre l’origine d’une preuve @cap:verifier-un-livrable/moteur', () => {
  it('rend les commandes du relecteur avec leur rôle et le nom de l’agent qui les a lancées', async () => {
    await setVerdict('approve');
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(rootJobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const seqs = r.data.verification.sequences;
    expect(seqs).toHaveLength(1);
    expect(seqs[0]!.source).toBe('reviewer');
    expect(seqs[0]!.sourceAgentName).toBe(REVIEWER_NAME);
    expect(seqs[0]!.runs.map((x) => [x.command, x.exitCode, x.verdict])).toEqual([
      ['npx playwright test tests/e2e/panier.spec.ts', 0, 'green'],
      ['npx playwright test tests/e2e/paiement.spec.ts', 1, 'red'],
    ]);
    // Chaque commande porte l'origine, pas seulement la séquence : c'est la
    // ligne que l'écran dessine.
    expect(seqs[0]!.runs.map((x) => x.source)).toEqual(['reviewer', 'reviewer']);
  });
});

describe('le récapitulatif porte le verdict de la relecture @cap:verifier-un-livrable/moteur', () => {
  it('rend le verdict et le fait qu’il demande des corrections', async () => {
    await setVerdict('request_changes');
    const summary = await deliveredSummary();
    expect(summary.review).toBe('request_changes');
    expect(summary.changesRequested).toBe(true);
  });

  it('rend l’approbation sans rien changer d’autre', async () => {
    await setVerdict('approve');
    const summary = await deliveredSummary();
    expect(summary.review).toBe('approve');
    expect(summary.changesRequested).toBe(false);
    // Les preuves du relecteur comptent comme les autres : deux commandes,
    // une verte.
    expect(summary.tests).toEqual({ passed: 1, total: 2 });
  });

  it('sans relecture, le récapitulatif conclut comme avant', async () => {
    await testDb.delete(toolCalls).where(eq(toolCalls.jobId, reviewerJobId));
    const summary = await deliveredSummary();
    expect(summary.review).toBeNull();
    expect(summary.changesRequested).toBe(false);
  });
});
