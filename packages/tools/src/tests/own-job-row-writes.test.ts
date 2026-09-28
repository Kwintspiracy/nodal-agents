// own-job-row-writes.test.ts — les écritures qu'un OUTIL fait sur la ligne de
// son job passent sous la prise du run (#566, revue Nodal de #575, passe 3).
//
// Le cas : le run A tient le job sous la prise 1 ; le faucheur le remet en
// file, le run B le reprend (prise 2) et termine avec SON résultat. L'outil de
// A, encore en cours, écrit ensuite sur la ligne : cette écriture ne doit
// RIEN changer. Prouvé sur la vraie base, dans le scope du run A
// (`withinRunScope` + `recordClaim`, ce que fait `runJob`).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, entities, eq, withinRunScope, recordClaim } from '@nodal-agents/db';
import { dashboardPublishTool } from '../builtin/dashboard-publish';
import { writeMutationIntent } from '../verification/intent';
import type { ToolContext } from '../types';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

/** Un job que B a repris (prise 2) et terminé avec son résultat. */
async function jobTermineParB(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'x',
      status: 'completed',
      claimGeneration: 2,
      result: 'le résultat de B',
      verificationSkippedSurfaces: [],
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

async function ligne(jobId: string) {
  const [r] = await db
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      updatedAt: agentJobs.updatedAt,
      skipped: agentJobs.verificationSkippedSurfaces,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r!;
}

function ctx(jobId: string): ToolContext {
  return {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

describe('a tool of a run that lost its job writes nothing on the job row (#566) @cap:suivre-execution/moteur', () => {
  it('dashboard_publish: refused with job_row_not_held, B’s result and updated_at intact', async () => {
    const jobId = await jobTermineParB();
    const avant = await ligne(jobId);

    const erreur = await withinRunScope(jobId, async () => {
      recordClaim(jobId, 1);
      return dashboardPublishTool
        .execute({ text: 'le texte périmé de A' }, ctx(jobId))
        .then(() => null)
        .catch((e: unknown) => e);
    });

    expect(String(erreur)).toContain('job_row_not_held');
    expect(await ligne(jobId)).toEqual(avant);
  });

  it('dashboard_publish under the run’s own claim still publishes', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'x',
        status: 'processing',
        claimGeneration: 1,
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;

    const out = await withinRunScope(jobId, async () => {
      recordClaim(jobId, 1);
      return dashboardPublishTool.execute({ text: 'publié' }, ctx(jobId));
    });

    expect(out).toEqual({ ok: true });
    expect((await ligne(jobId)).result).toBe('publié');
  });

  it('the verification intent’s skipped-surface trace: nothing written on B’s row', async () => {
    const jobId = await jobTermineParB();
    // La surface est décochée : l'intention ne pose rien et TRACE la surface sautée.
    await db
      .update(entities)
      .set({ verificationSurfaces: { fileOps: false } })
      .where(eq(entities.id, seed.entityId));
    try {
      const avant = await ligne(jobId);

      await withinRunScope(jobId, async () => {
        recordClaim(jobId, 1);
        return writeMutationIntent(
          { db: db as never, entityId: seed.entityId, jobId, workspaces: [] } as never,
          { surface: 'fileOps', targets: [] } as never,
        );
      });

      expect(await ligne(jobId)).toEqual(avant);
    } finally {
      await db
        .update(entities)
        .set({ verificationSurfaces: {} })
        .where(eq(entities.id, seed.entityId));
    }
  });

  it('the same trace under the run’s own claim is written', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'x',
        status: 'processing',
        claimGeneration: 1,
        verificationSkippedSurfaces: [],
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;
    await db
      .update(entities)
      .set({ verificationSurfaces: { fileOps: false } })
      .where(eq(entities.id, seed.entityId));
    try {
      await withinRunScope(jobId, async () => {
        recordClaim(jobId, 1);
        return writeMutationIntent(
          { db: db as never, entityId: seed.entityId, jobId, workspaces: [] } as never,
          { surface: 'fileOps', targets: [] } as never,
        );
      });

      expect((await ligne(jobId)).skipped).toEqual(['fileOps']);
    } finally {
      await db
        .update(entities)
        .set({ verificationSurfaces: {} })
        .where(eq(entities.id, seed.entityId));
    }
  });
});
