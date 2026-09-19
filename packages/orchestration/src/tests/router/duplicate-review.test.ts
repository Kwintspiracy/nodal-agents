// router/duplicate-review.test.ts — la seconde revue de la même chose ne part
// pas (issue #173). Vraie base, vraies lignes `agent_jobs` et `tool_calls`.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, toolCalls, users, entities } from '@nodal-agents/db';
import {
  extractReviewTarget,
  findDeliveredReviewForTarget,
  describeDuplicateReview,
  DUPLICATE_REVIEW_REFUSAL_CODE,
} from '../../router/duplicate-review';
import type { EntityId, JobId } from '../../types';

let db: TestDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
});

/** La sortie EXACTE que `review_verdict` écrit quand il a validé un verdict. */
const VERDICT_OUTPUT = {
  ok: true,
  verdict: 'request_changes',
  summary: 'PR #185 relue : le retry classe un 429 passager en facturation.',
  findings: [
    {
      file: 'packages/llm/src/retry.ts',
      line: 99,
      issue: 'La liste de mots-clés classe un 429 passager en facturation.',
      severity: 'blocker',
    },
  ],
  counts: { blocker: 1, major: 0, minor: 0 },
};

interface Fixture {
  entityId: string;
  parentJobId: string;
  reviewerSlug: string;
  reviewerId: string;
  otherReviewerSlug: string;
  otherReviewerId: string;
  devId: string;
}

async function seedTeam(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `dup-${suffix}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-dup-${suffix}` })
    .returning();
  const [parentAgent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Orchestrateur',
      slug: `orch-${suffix}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();
  const [reviewer] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Relecteur Alpha',
      slug: `relecteur-alpha-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const [otherReviewer] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Relecteur Bêta',
      slug: `relecteur-beta-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const [dev] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Dev',
      slug: `dev-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const [parentJob] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: parentAgent!.id,
      channel: 'internal',
      task: 'Fais relire les PR ouvertes.',
      status: 'processing',
    })
    .returning();

  return {
    entityId: entity!.id,
    parentJobId: parentJob!.id,
    reviewerSlug: reviewer!.slug,
    reviewerId: reviewer!.id,
    otherReviewerSlug: otherReviewer!.slug,
    otherReviewerId: otherReviewer!.id,
    devId: dev!.id,
  };
}

/** L'instant du verdict dans les scénarios de fenêtre — fixe, jamais « maintenant ». */
const VERDICT_AT = new Date('2026-09-19T10:00:00.000Z');

/** Un enfant terminé qui a écrit son verdict, comme le runner l'écrit. */
async function seedDeliveredReview(
  fx: Fixture,
  agentId: string,
  task: string,
  output: unknown = VERDICT_OUTPUT,
  verdictAt: Date = VERDICT_AT,
): Promise<string> {
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId: fx.entityId,
      agentId,
      channel: 'internal',
      task,
      status: 'completed',
      parentJobId: fx.parentJobId,
      delegationDepth: 1,
      completedAt: verdictAt,
    })
    .returning();
  await db.insert(toolCalls).values({
    entityId: fx.entityId,
    jobId: child!.id,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: typeof output === 'string' ? output : JSON.stringify(output),
    turn: 3,
    createdAt: verdictAt,
  });
  return child!.id;
}

/** Un autre délégué du même parent, dans l'état et à l'instant voulus. */
async function seedSiblingDelegation(
  fx: Fixture,
  agentId: string,
  task: string,
  status: 'completed' | 'processing' | 'failed',
  completedAt: Date | null,
): Promise<string> {
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId: fx.entityId,
      agentId,
      channel: 'internal',
      task,
      status,
      parentJobId: fx.parentJobId,
      delegationDepth: 1,
      completedAt,
    })
    .returning();
  return child!.id;
}

describe('extractReviewTarget @cap:organiser-equipe/moteur', () => {
  it('lit la PR quelle que soit la forme écrite, et la rend normalisée', () => {
    expect(extractReviewTarget('Relis la PR #185 et rends ton verdict.')).toBe('pr:185');
    expect(extractReviewTarget('review PR 185 now')).toBe('pr:185');
    expect(extractReviewTarget('relecture pr-185')).toBe('pr:185');
    expect(extractReviewTarget('Review pull request 185')).toBe('pr:185');
  });

  it('rend le même ensemble quel que soit l’ordre, et un ensemble DIFFÉRENT quand on en ajoute', () => {
    expect(extractReviewTarget('relis #190 et #185')).toBe(
      extractReviewTarget('relis #185 puis #190'),
    );
    expect(extractReviewTarget('relis #185')).not.toBe(extractReviewTarget('relis #185 et #190'));
  });

  it('retombe sur le chemin de paquet quand aucune PR n’est citée', () => {
    expect(extractReviewTarget('Relis packages/orchestration/src/router.')).toBe(
      'path:packages/orchestration/src/router',
    );
    expect(extractReviewTarget('Relis apps/web et packages/db')).toBe('path:apps/web+packages/db');
  });

  it('lit le chemin quelle que soit la casse — `APPS/Web` et `apps/web` sont la même cible', () => {
    expect(extractReviewTarget('Relis APPS/Web.')).toBe('path:apps/web');
    expect(extractReviewTarget('Relis APPS/Web.')).toBe(extractReviewTarget('Relis apps/web.'));
  });

  it('préfère la PR au chemin quand la tâche cite les deux', () => {
    expect(extractReviewTarget('Relis la PR #185, surtout packages/llm.')).toBe('pr:185');
  });

  it('rend null quand rien n’est reconnaissable — pas de cible devinée', () => {
    expect(extractReviewTarget('Relis le dernier travail du dev.')).toBeNull();
    expect(extractReviewTarget('')).toBeNull();
    expect(extractReviewTarget(null)).toBeNull();
  });
});

describe('findDeliveredReviewForTarget @cap:organiser-equipe/moteur', () => {
  it('nomme le verdict déjà livré quand le même relecteur est redemandé sur la même PR', async () => {
    const fx = await seedTeam();
    const childJobId = await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis la PR #185 et dis-moi si elle est mergeable.',
    });

    expect(match).not.toBeNull();
    expect(match?.childJobId).toBe(childJobId);
    expect(match?.target).toBe('pr:185');
    expect(match?.verdict.verdict).toBe('request_changes');
    expect(match?.verdict.summary).toBe(VERDICT_OUTPUT.summary);
    expect(match?.verdict.counts).toEqual({ blocker: 1, major: 0, minor: 0 });

    const refusal = describeDuplicateReview(match!);
    expect(refusal).toContain(DUPLICATE_REVIEW_REFUSAL_CODE);
    expect(refusal).toContain(childJobId);
    expect(refusal).toContain('request_changes');
    expect(refusal).toContain(VERDICT_OUTPUT.summary);
  });

  it('refuse `APPS/Web` après une revue de `apps/web` — deux écritures, une seule cible', async () => {
    const fx = await seedTeam();
    const childJobId = await seedDeliveredReview(fx, fx.reviewerId, 'Relis apps/web.');

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis APPS/Web.',
    });
    expect(match?.childJobId).toBe(childJobId);
    expect(match?.target).toBe('path:apps/web');
  });

  it('LAISSE PASSER la relecture quand une correction a ABOUTI depuis le verdict', async () => {
    // Boucle de travail réelle : relire → faire corriger → refaire relire. La
    // cible a changé entre les deux passes, la seconde n'est pas un doublon.
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');
    await seedSiblingDelegation(
      fx,
      fx.devId,
      'Corrige les constats de la PR #185.',
      'completed',
      new Date(VERDICT_AT.getTime() + 60_000),
    );

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: fx.parentJobId as JobId,
        entityId: fx.entityId as EntityId,
        childSlug: fx.reviewerSlug,
        task: 'Relis la PR #185 après correction.',
      }),
    ).toBeNull();
  });

  it('REFUSE quand rien n’a abouti entre les deux relectures', async () => {
    const fx = await seedTeam();
    const childJobId = await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');
    // Une correction lancée AVANT le verdict et terminée avant lui ne dit rien
    // sur l'état de la cible après le verdict.
    await seedSiblingDelegation(
      fx,
      fx.devId,
      'Prépare la PR #185.',
      'completed',
      new Date(VERDICT_AT.getTime() - 60_000),
    );

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis la PR #185.',
    });
    expect(match?.childJobId).toBe(childJobId);
  });

  it('une délégation ENCORE EN COURS ne compte pas comme « quelque chose a changé »', async () => {
    const fx = await seedTeam();
    const childJobId = await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');
    await seedSiblingDelegation(fx, fx.devId, 'Corrige la PR #185.', 'processing', null);

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis la PR #185.',
    });
    expect(match?.childJobId).toBe(childJobId);
  });

  it('une délégation ÉCHOUÉE depuis le verdict ne compte pas non plus', async () => {
    const fx = await seedTeam();
    const childJobId = await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');
    await seedSiblingDelegation(
      fx,
      fx.devId,
      'Corrige la PR #185.',
      'failed',
      new Date(VERDICT_AT.getTime() + 60_000),
    );

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis la PR #185.',
    });
    expect(match?.childJobId).toBe(childJobId);
  });

  it('laisse passer une AUTRE cible', async () => {
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: fx.parentJobId as JobId,
        entityId: fx.entityId as EntityId,
        childSlug: fx.reviewerSlug,
        task: 'Relis la PR #190.',
      }),
    ).toBeNull();
  });

  it('laisse passer une tâche SANS cible reconnaissable', async () => {
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: fx.parentJobId as JobId,
        entityId: fx.entityId as EntityId,
        childSlug: fx.reviewerSlug,
        task: 'Regarde ce que le dev vient de faire et dis-moi ce que tu en penses.',
      }),
    ).toBeNull();
  });

  it('laisse passer un AUTRE relecteur sur la même PR — la garde ne ferme pas le second avis', async () => {
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: fx.parentJobId as JobId,
        entityId: fx.entityId as EntityId,
        childSlug: fx.otherReviewerSlug,
        task: 'Relis la PR #185.',
      }),
    ).toBeNull();
  });

  it('ignore un enfant qui n’a livré AUCUN verdict valide', async () => {
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.', {
      outcome: 'error',
      error: { message: 'request_changes requires at least one finding' },
    });

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: fx.parentJobId as JobId,
        entityId: fx.entityId as EntityId,
        childSlug: fx.reviewerSlug,
        task: 'Relis la PR #185.',
      }),
    ).toBeNull();
  });

  it('ne voit pas l’enfant d’un AUTRE job parent — la garde est bornée à ce job', async () => {
    const fx = await seedTeam();
    await seedDeliveredReview(fx, fx.reviewerId, 'Relis la PR #185.');
    const autre = await seedTeam();

    expect(
      await findDeliveredReviewForTarget(db, {
        parentJobId: autre.parentJobId as JobId,
        entityId: autre.entityId as EntityId,
        childSlug: fx.reviewerSlug,
        task: 'Relis la PR #185.',
      }),
    ).toBeNull();
  });

  it('retient le DERNIER appel de l’enfant, celui qui corrige un appel refusé', async () => {
    const fx = await seedTeam();
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: fx.entityId,
        agentId: fx.reviewerId,
        channel: 'internal',
        task: 'Relis la PR #185.',
        status: 'completed',
        parentJobId: fx.parentJobId,
        delegationDepth: 1,
      })
      .returning();
    // Premier appel REFUSÉ par le schéma, second appel accepté : c'est le
    // second qui fait foi.
    await db.insert(toolCalls).values({
      entityId: fx.entityId,
      jobId: child!.id,
      toolName: 'review_verdict',
      toolInput: {},
      toolOutput: JSON.stringify({ outcome: 'error', error: { message: 'no finding' } }),
      turn: 3,
    });
    await db.insert(toolCalls).values({
      entityId: fx.entityId,
      jobId: child!.id,
      toolName: 'review_verdict',
      toolInput: {},
      toolOutput: JSON.stringify({ ...VERDICT_OUTPUT, verdict: 'approve', findings: [] }),
      turn: 3,
    });

    const match = await findDeliveredReviewForTarget(db, {
      parentJobId: fx.parentJobId as JobId,
      entityId: fx.entityId as EntityId,
      childSlug: fx.reviewerSlug,
      task: 'Relis la PR #185.',
    });
    expect(match?.verdict.verdict).toBe('approve');
  });
});
