// reclaim-jobs.test.ts — un runner qui redémarre ne laisse personne en plan
// (issue #186).
//
// L'incident du 18/09/2026 : la stack redémarre pendant une délégation de
// revue ; l'enfant reste `processing`, le parent `awaiting_delegation`, et rien
// ne les reprend. Ce qui se prouve ici, sur de VRAIES lignes : un job que plus
// aucun runner ne tient échoue avec son code typé, son parent repart avec cet
// échec dans son enregistrement de délégation, et un job qui bat encore n'est
// pas touché.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agentTasks } from '@nodal-agents/db';
import {
  reclaimJobsOfDeadRunners,
  runnerRestartedStopLine,
  RUNNER_LIVENESS_WINDOW_MS,
  RUNNER_RESTARTED_CODE,
} from '../../cron/reclaim-jobs.ts';
import { DELEGATION_FAILED_MARKER } from '@nodal-agents/orchestration';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

/** Le dernier battement de ce job : `updated_at`, posé où on veut. */
function ilY(ms: number): Date {
  return new Date(Date.now() - ms);
}

async function insertJob(values: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Relis la PR',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function jobRow(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
      messages: agentJobs.messages,
      updatedAt: agentJobs.updatedAt,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Un enfant de délégation laissé `processing`, et le parent qui l'attend. */
async function seedDelegationCoupee(toolUseId: string): Promise<{
  parentId: string;
  childId: string;
}> {
  const parentId = await insertJob({
    status: 'awaiting_delegation',
    messages: [
      { role: 'user', content: 'fais relire la PR' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: toolUseId,
            toolName: 'assign_reviewer',
            input: { task: 'relis la PR' },
          },
        ],
      },
    ],
  });
  const childId = await insertJob({
    channel: 'internal',
    parentJobId: parentId,
    status: 'processing',
    updatedAt: ilY(RUNNER_LIVENESS_WINDOW_MS + 60_000),
  });
  await db
    .update(agentJobs)
    .set({
      pendingDelegation: {
        type: 'single',
        toolUseId,
        toolName: 'assign_reviewer',
        subJobId: childId,
      },
    })
    .where(eq(agentJobs.id, parentId));
  return { parentId, childId };
}

describe('un job que plus aucun runner ne tient @cap:parler-a-un-agent/moteur', () => {
  it('échoue avec le code typé et une ligne de faits, jamais en silence', async () => {
    const jobId = await insertJob({
      status: 'processing',
      updatedAt: ilY(RUNNER_LIVENESS_WINDOW_MS + 30_000),
    });

    const result = await reclaimJobsOfDeadRunners(db);

    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(RUNNER_RESTARTED_CODE);
    expect(row.result ?? '').toContain('[stopped: runner restarted');
    expect(row.result ?? '').toContain('status processing');
    expect(row.result ?? '').toContain('no heartbeat for');
  });

  it('un job qui BAT ENCORE n’est pas touché', async () => {
    // Le battement d'un runner vivant est de 60 s : ce job a été touché il y a
    // dix secondes, il est tenu par quelqu'un.
    const jobId = await insertJob({ status: 'processing', updatedAt: ilY(10_000) });

    await reclaimJobsOfDeadRunners(db);

    const row = await jobRow(jobId);
    expect(row.status).toBe('processing');
    expect(row.error).toBeFalsy();
  });

  it('un orchestrateur dont le TABLEAU DE TÂCHES tourne encore n’est pas touché', async () => {
    // Il ne bat pas — il a réparti son travail et attend. Le faucheur le
    // protège déjà à cinq minutes ; ici la fenêtre est bien plus courte, donc
    // le tuer serait le premier effet de ce code, pas le dernier.
    const jobId = await insertJob({
      status: 'processing',
      updatedAt: ilY(RUNNER_LIVENESS_WINDOW_MS + 120_000),
    });
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      rootJobId: jobId,
      orchestratorId: seed.agentId,
      title: 'une tâche en cours',
      status: 'in_progress',
    } as never);

    await reclaimJobsOfDeadRunners(db);

    const row = await jobRow(jobId);
    expect(row.status).toBe('processing');
  });
});

describe('le parent d’un enfant repris @cap:organiser-equipe/moteur', () => {
  it('repart avec l’échec typé, au lieu d’attendre pour toujours', async () => {
    const { parentId, childId } = await seedDelegationCoupee('assign-r1');

    const result = await reclaimJobsOfDeadRunners(db);

    expect(result.parentsResumed).toBeGreaterThanOrEqual(1);

    const child = await jobRow(childId);
    expect(child.status).toBe('failed');
    expect(child.error).toBe(RUNNER_RESTARTED_CODE);

    const parent = await jobRow(parentId);
    // Il ne dort plus : le worker le reprendra comme n'importe quel `pending`.
    expect(parent.status).toBe('pending');
    const last = (parent.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    expect(last.role).toBe('tool');
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe('error-text');
    expect(part.output.value).toContain(DELEGATION_FAILED_MARKER);
    expect(part.output.value).toContain(RUNNER_RESTARTED_CODE);
    // Le record TYPÉ, celui que la PR #170 porte, avec sa raison de sortie.
    expect(part.output.value).toContain('"exit_reason": "runner_restarted"');
  });

  it('un parent qui attend une AUTRE délégation n’est pas réveillé', async () => {
    // Le réveiller répondrait au mauvais appel d'outil : son message porterait
    // un `tool_result` pour un `tool_use` qui n'est pas celui-là.
    const { parentId, childId } = await seedDelegationCoupee('assign-r2');
    await db
      .update(agentJobs)
      .set({
        pendingDelegation: {
          type: 'single',
          toolUseId: 'assign-r2',
          toolName: 'assign_reviewer',
          subJobId: '00000000-0000-0000-0000-0000000000ff',
        },
      })
      .where(eq(agentJobs.id, parentId));

    await reclaimJobsOfDeadRunners(db);

    const child = await jobRow(childId);
    expect(child.status).toBe('failed');
    const parent = await jobRow(parentId);
    expect(parent.status).toBe('awaiting_delegation');
  });

  it('un job SANS parent est repris sans rien réveiller', async () => {
    const jobId = await insertJob({
      status: 'processing',
      updatedAt: ilY(RUNNER_LIVENESS_WINDOW_MS + 5_000),
    });

    const result = await reclaimJobsOfDeadRunners(db);

    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    expect((await jobRow(jobId)).status).toBe('failed');
  });
});

describe('les faits d’un runner redémarré, mis en mots @cap:parler-a-un-agent/moteur', () => {
  it('la ligne lue par la personne est une ligne de plateforme, entre crochets', () => {
    expect(runnerRestartedStopLine({ status: 'processing', idleMs: 192_000 })).toBe(
      '[stopped: runner restarted — status processing, no heartbeat for 3m12s]',
    );
  });

  it('sous la minute, elle le dit en secondes', () => {
    expect(runnerRestartedStopLine({ status: 'processing', idleMs: 45_000 })).toBe(
      '[stopped: runner restarted — status processing, no heartbeat for 45s]',
    );
  });
});
