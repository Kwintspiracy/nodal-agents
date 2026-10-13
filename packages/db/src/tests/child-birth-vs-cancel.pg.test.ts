// child-birth-vs-cancel.pg.test.ts — un arrêt et une naissance d'enfant se
// sérialisent, sur un VRAI Postgres à deux connexions (#567, revue Codex de
// #572, passe 3).
//
// @cap:parler-par-canal-externe/moteur
//
// Le trou : `cancelJobTree` photographiait les descendants AVANT d'annuler. Un
// worker du tableau (cron/execute-ready.ts) ou une délégation `assign_*`
// (router/delegate.ts) qui insérait un enfant juste après la photo le faisait
// naître absent de l'annulation : l'enfant tournait, et l'outil avait répondu
// « stopped ». PGlite n'a qu'une connexion, il ne peut pas montrer deux
// transactions qui s'attendent : ce fichier le peut.
//
// Les deux sens, chacun avec le VRAI code d'un côté :
//   1. une naissance tient le parent (`FOR SHARE`, comme `insertChildJob`) et
//      insère pendant que `cancelJobTree` tourne : l'annulation attend, puis
//      VOIT l'enfant et l'annule ;
//   2. une annulation tient le parent (verrou + `cancelled`, comme
//      `cancelJobTree`) pendant qu'`insertChildJob` arrive : la naissance
//      attend, puis REFUSE, et aucune ligne n'est créée.
//
// Mutations vérifiées : `.for('update')` retiré de la descente de
// `cancelJobTree` → le sens 1 rougit (l'enfant reste `pending`) ; le contrôle du
// parent retiré d'`insertChildJob` → le sens 2 rougit (un enfant naît).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  agents,
  agentJobs,
  entities,
  users,
  cancelJobTree,
  insertChildJob,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;
const seed = { entityId: '', agentId: '' };

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

const HOLD_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newParent(db: AnyDrizzleDb): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'Fais-moi un portrait',
      status: 'awaiting_delegation',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

describe('a cancel and a child birth serialize @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the real migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    const { db, close } = createClient(pg.url, { max: 1 });
    try {
      const [user] = await db
        .insert(users)
        .values({ email: `birth-${Date.now()}@example.com` })
        .returning({ id: users.id });
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E', slug: `birth-${Date.now()}` })
        .returning({ id: entities.id });
      const [agent] = await db
        .insert(agents)
        .values({
          entityId: entity!.id,
          name: 'Alfred',
          slug: `alfred-${Date.now()}`,
          personality: 'test',
        })
        .returning({ id: agents.id });
      seed.entityId = entity!.id;
      seed.agentId = agent!.id;
    } finally {
      await close();
    }
  }, 120_000);

  it('1. a child born deep in the tree while the cancel runs is seen and cancelled by it', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      // Le run : une tête, et un délégué qui délègue à son tour. La naissance a
      // lieu SOUS le délégué, un niveau plus bas que la cible de l'arrêt : c'est
      // la descente de l'annulation qui doit l'attendre, pas seulement la tête.
      const head = await newParent(a.db as unknown as AnyDrizzleDb);
      const [delegate] = await a.db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'internal',
          task: 'Generate the portrait',
          status: 'processing',
          parentJobId: head,
        })
        .returning({ id: agentJobs.id });
      let childId = '';
      // A : la naissance tient le délégué, puis insère l'enfant après HOLD_MS.
      const birth = a.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agent_jobs WHERE id = ${delegate!.id} FOR SHARE`);
        await sleep(HOLD_MS);
        const [child] = await tx
          .insert(agentJobs)
          .values({
            entityId: seed.entityId,
            agentId: seed.agentId,
            channel: 'task-board',
            task: 'Upscale the portrait',
            status: 'pending',
            parentJobId: delegate!.id,
          })
          .returning({ id: agentJobs.id });
        childId = child!.id;
      });
      // B : l'annulation de la tête part PENDANT la naissance.
      await sleep(150);
      const cancelled = await cancelJobTree(b.db as unknown as AnyDrizzleDb, {
        entityId: seed.entityId,
        jobId: head,
      });
      await birth;

      expect(cancelled.jobIds.sort()).toEqual([head, delegate!.id, childId].sort());
      const [child] = await a.db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, childId));
      expect(child?.status).toBe('cancelled');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('2. a birth arriving while the cancel holds the parent waits, then is refused', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const parent = await newParent(a.db as unknown as AnyDrizzleDb);
      // A : l'annulation tient le parent et le passe à `cancelled`.
      const cancel = a.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agent_jobs WHERE id = ${parent} FOR UPDATE`);
        await tx.execute(
          sql`UPDATE agent_jobs SET status = 'cancelled', updated_at = now() WHERE id = ${parent}`,
        );
        await sleep(HOLD_MS);
      });
      // B : la naissance arrive PENDANT l'annulation.
      await sleep(150);
      const born = await insertChildJob(b.db as unknown as AnyDrizzleDb, {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 'Generate the portrait',
        status: 'pending',
        parentJobId: parent,
      });
      await cancel;

      expect(born).toEqual({ refused: 'parent_not_live', parentStatus: 'cancelled' });
      const children = await a.db
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(eq(agentJobs.parentJobId, parent));
      expect(children).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
