// conversation-inbox-race.pg.test.ts — un message qui arrive pendant que la
// tête de sa conversation FINIT n'est jamais perdu (#531), sur un VRAI
// Postgres à deux connexions, avec les VRAIES migrations (0141 comprise).
//
// @cap:parler-par-canal-externe/moteur
//
// Le cas : la personne précise sa demande pendant le dernier appel au modèle ;
// le run conclut et pose son statut terminal pendant que le canal remet le
// message. PGlite n'a qu'une connexion : il ne peut pas montrer deux
// transactions qui s'attendent. Ici, les deux ordres, chacun avec le VRAI code
// de l'autre côté :
//   1. la fin tient la tête (statut terminal posé, pas encore commité) quand le
//      message arrive : `deliverOrStartTurn` attend le verrou, relit la tête
//      terminale, et DÉMARRE une tête qui porte le message ;
//   2. la remise tient la tête (entrée ajoutée, pas encore commitée) quand la
//      fin arrive : l'écriture terminale attend, puis le déclencheur voit
//      l'entrée et fait naître une tête qui la porte.
// Dans les deux ordres : exactement une tête nouvelle, qui porte le message, et
// la file de l'ancienne est vide.
//
// Mutations vérifiées : `.for('update')` retiré de la recherche de la tête dans
// `deliverOrStartTurn` → l'ordre 1 rougit (la remise lit la tête encore
// vivante, la retrouve terminée à l'écriture, et échoue au lieu de démarrer
// une tête) ; le déclencheur retiré de la migration → l'ordre 2 rougit (aucune
// tête ne naît, le message reste dans la file d'un job terminé).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  and,
  eq,
  isNull,
  agents,
  agentJobs,
  conversations,
  entities,
  users,
  deliverOrStartTurn,
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
const FOLLOW_UP = 'et mets-le dans le dossier partagé';

async function runningHead(db: AnyDrizzleDb): Promise<{ conversationId: string; head: string }> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '555' })
    .returning({ id: conversations.id });
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId: conv!.id,
      task: 'Fais-moi un portrait',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return { conversationId: conv!.id, head: row!.id };
}

function deliver(db: AnyDrizzleDb, conversationId: string) {
  return deliverOrStartTurn(db, {
    entityId: seed.entityId,
    conversationId,
    message: { task: FOLLOW_UP, content: FOLLOW_UP },
    start: {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId,
      status: 'pending',
      task: FOLLOW_UP,
      messages: [{ role: 'user', content: FOLLOW_UP }],
    },
  });
}

async function heads(db: AnyDrizzleDb, conversationId: string) {
  return db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      task: agentJobs.task,
      inbox: agentJobs.inbox,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(agentJobs.createdAt);
}

describe('a message arriving while its head finishes is never lost @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the real migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    const { db, close } = createClient(pg.url, { max: 1 });
    try {
      const [user] = await db
        .insert(users)
        .values({ email: `inbox-${Date.now()}@example.com` })
        .returning({ id: users.id });
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E', slug: `inbox-${Date.now()}` })
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

  it('1. the terminal write holds the head when the message arrives: the message waits, then starts its own head', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      // A : la fin du run, statut terminal posé et tenu HOLD_MS avant le commit.
      const finish = a.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE agent_jobs SET status = 'completed', updated_at = now() WHERE id = ${head}`,
        );
        await sleep(HOLD_MS);
      });
      // B : le message arrive PENDANT la fin.
      await sleep(150);
      const turn = await deliver(b.db as unknown as AnyDrizzleDb, conversationId);
      await finish;

      expect(turn.kind).toBe('started');
      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      expect(rows.map((r) => ({ status: r.status, task: r.task, inbox: r.inbox }))).toEqual([
        { status: 'completed', task: 'Fais-moi un portrait', inbox: [] },
        { status: 'pending', task: FOLLOW_UP, inbox: [] },
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('2. the delivery holds the head when the run finishes: the terminal write waits, then the trigger relaunches the message', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      // A : la remise, dans une transaction tenue HOLD_MS après l'ajout.
      let delivered: Awaited<ReturnType<typeof deliver>> | null = null;
      const delivery = a.db.transaction(async (tx) => {
        delivered = await deliver(tx as unknown as AnyDrizzleDb, conversationId);
        await sleep(HOLD_MS);
      });
      // B : le run conclut PENDANT la remise.
      await sleep(150);
      await b.db
        .update(agentJobs)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(agentJobs.id, head));
      await delivery;

      expect(delivered).toMatchObject({ kind: 'delivered', headJobId: head });
      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      expect(rows.map((r) => ({ status: r.status, task: r.task, inbox: r.inbox }))).toEqual([
        { status: 'completed', task: 'Fais-moi un portrait', inbox: [] },
        { status: 'pending', task: FOLLOW_UP, inbox: [] },
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
