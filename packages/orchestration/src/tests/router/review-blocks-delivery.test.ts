// router/review-blocks-delivery.test.ts — un `request_changes` EMPÊCHE le
// parent de conclure à une livraison (issue #59), sur une vraie base.
//
// @cap:verifier-un-livrable/moteur
//
// La décision du propriétaire, le 19/09/2026 : le verdict d'un relecteur ne
// voyage plus seulement comme information, il pose un INTERDIT. Le parent le
// reçoit dans un champ typé de son `tool_result` — pas entre les lignes d'un
// résumé qu'un modèle peut lire de travers.
//
// Ce que ces cas prouvent : le champ vaut le code sur `request_changes`, `null`
// sur `approve`, et `null` sur une délégation ordinaire — un champ toujours
// présent, jamais un contrat qui apparaît et disparaît.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, entities, toolCalls, users } from '@nodal-agents/db';
import { REVIEW_CHANGES_REQUESTED, reviewBlocksDelivery } from '@nodal-agents/shared';
import { resumeDelegated } from '../../router/resume';
import type { JobId } from '../../types';

let db: TestDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
});

const TOOL_USE_ID = 'tu_p13';

interface Ctx {
  entityId: string;
  parentJobId: string;
  childJobId: string;
}

async function seedPair(): Promise<Ctx> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `rbd-${suffix}@example.test` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-rbd-${suffix}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Orchestrator',
      slug: `orch-${suffix}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();
  const [parent] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: agent!.id,
      channel: 'api',
      task: 'ship the little web app',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'ship the little web app' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'assign_test_agent', input: {} }],
        },
      ],
      pendingDelegation: {
        type: 'single',
        toolUseId: TOOL_USE_ID,
        toolName: 'assign_test_agent',
        subJobId: 'placeholder',
      },
    })
    .returning();
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: agent!.id,
      channel: 'internal',
      task: 'review the little web app',
      status: 'completed',
      parentJobId: parent!.id,
    })
    .returning();
  return { entityId: entity!.id, parentJobId: parent!.id, childJobId: child!.id };
}

async function recordVerdict(ctx: Ctx, verdict: 'approve' | 'request_changes'): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: ctx.entityId,
    jobId: ctx.childJobId,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: JSON.stringify({
      ok: true,
      verdict,
      summary: 'Read the diff, ran the suite.',
      findings:
        verdict === 'request_changes'
          ? [{ file: 'app.js', issue: 'The cart total is off by one.', severity: 'blocker' }]
          : [],
      counts:
        verdict === 'request_changes'
          ? { blocker: 1, major: 0, minor: 0 }
          : { blocker: 0, major: 0, minor: 0 },
    }),
    turn: 1,
  });
}

/** Le `tool_result` que le parent vient de recevoir, décodé. */
async function parentPayload(parentJobId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId));
  const msgs = row?.messages as Array<{ role: string; content: unknown }>;
  const last = msgs[msgs.length - 1];
  const content = last?.content as Array<{
    type: string;
    output?: { type: string; value: unknown };
  }>;
  const result = content.find((b) => b.type === 'tool-result');
  return JSON.parse(String(result?.output?.value)) as Record<string, unknown>;
}

describe('delivery_blocked @cap:verifier-un-livrable/moteur', () => {
  it('pose le code sur un request_changes — le parent ne peut pas conclure « livré »', async () => {
    const ctx = await seedPair();
    await recordVerdict(ctx, 'request_changes');

    await resumeDelegated(
      ctx.parentJobId as JobId,
      ctx.childJobId as JobId,
      'Voilà ma relecture.',
      db,
    );

    const payload = await parentPayload(ctx.parentJobId);
    expect(payload['delivery_blocked']).toBe(REVIEW_CHANGES_REQUESTED);
    // Le verdict voyage toujours avec, entier : l'interdit et sa raison.
    const verdict = payload['review_verdict'] as Record<string, unknown>;
    expect(verdict['verdict']).toBe('request_changes');
  });

  it('ne bloque RIEN sur un approve — le champ est présent et nul', async () => {
    const ctx = await seedPair();
    await recordVerdict(ctx, 'approve');

    await resumeDelegated(ctx.parentJobId as JobId, ctx.childJobId as JobId, 'C’est bon.', db);

    const payload = await parentPayload(ctx.parentJobId);
    expect(payload).toHaveProperty('delivery_blocked');
    expect(payload['delivery_blocked']).toBeNull();
    expect((payload['review_verdict'] as Record<string, unknown>)['verdict']).toBe('approve');
  });

  it('ne bloque RIEN sur une délégation qui n’est pas une revue', async () => {
    const ctx = await seedPair();

    await resumeDelegated(ctx.parentJobId as JobId, ctx.childJobId as JobId, 'Fait.', db);

    const payload = await parentPayload(ctx.parentJobId);
    expect(payload).toHaveProperty('delivery_blocked');
    expect(payload['delivery_blocked']).toBeNull();
    expect(payload['review_verdict']).toBeNull();
  });
});

describe('reviewBlocksDelivery @cap:verifier-un-livrable/moteur', () => {
  it('ne bloque que sur request_changes, et jamais sur une absence de relecture', () => {
    expect(reviewBlocksDelivery('request_changes')).toBe(true);
    expect(reviewBlocksDelivery({ verdict: 'request_changes' })).toBe(true);
    expect(reviewBlocksDelivery('approve')).toBe(false);
    expect(reviewBlocksDelivery(null)).toBe(false);
    expect(reviewBlocksDelivery(undefined)).toBe(false);
  });
});
