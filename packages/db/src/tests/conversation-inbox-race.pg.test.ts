// conversation-inbox-race.pg.test.ts — les écrivains qui décident d'une tête
// de conversation se sérialisent (#531), sur un VRAI Postgres à deux
// connexions, avec les VRAIES migrations (0141 comprise).
//
// @cap:parler-par-canal-externe/moteur
//
// PGlite n'a qu'une connexion : il ne peut pas montrer deux transactions qui
// s'attendent. Ici, chaque ordre avec le VRAI code des deux côtés :
//   1. la fin tient la tête (statut terminal posé, pas encore commité) quand un
//      message arrive : `startConversationTurn` attend, relit, voit la
//      conversation au repos et démarre une tête « au repos » ;
//   2. une transmission (`deliverToConversationJob`) tient la tête quand le run
//      finit : l'écriture terminale attend, puis le déclencheur voit l'entrée
//      et fait naître une tête qui la porte ;
//   3. (revue de #642, passe 1) la fin relance une file NON vide PENDANT qu'un
//      message arrive : le message démarre un tour de réponse PENDANT la tête
//      relancée — jamais une seconde tête « au repos » à côté d'elle ;
//   4. `/stop` PENDANT cette fin : rien ne reste vivant, et le message relancé
//      est rendu comme retiré ;
//   5. deux messages simultanés sur une conversation au repos : une tête, et
//      un tour de réponse pendant elle.
//
// Mutations vérifiées : le déclencheur retiré de la migration → 2 rougit
// (aucune tête ne naît) ; la relecture après la lecture verrouillée retirée →
// 3 rougit (une tête « au repos » à côté de la relancée) ; la descente par
// `relaunched_from_job_id` retirée de `cancelJobTree` → 4 rougit (la tête
// relancée tourne) ; le verrou consultatif rendu propre à chaque appel → 5
// rougit (deux têtes « au repos »).

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
  deliverToConversationJob,
  startConversationTurn,
  stopConversationRuns,
} from '@nodal-agents/db';
import type { AnyDrizzleDb, ConversationTurn } from '@nodal-agents/db';
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

async function newConversation(db: AnyDrizzleDb): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '555' })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function runningHead(db: AnyDrizzleDb): Promise<{ conversationId: string; head: string }> {
  const conversationId = await newConversation(db);
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId,
      task: 'Fais-moi un portrait',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return { conversationId, head: row!.id };
}

/** Un message de canal, par le point de décision. */
function send(db: AnyDrizzleDb, conversationId: string, text = FOLLOW_UP) {
  return startConversationTurn(db, {
    entityId: seed.entityId,
    conversationId,
    start: {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId,
      status: 'pending',
      task: text,
      messages: [{ role: 'user', content: text }],
    },
  });
}

function forward(db: AnyDrizzleDb, conversationId: string, jobId: string, text: string) {
  return deliverToConversationJob(db, { entityId: seed.entityId, conversationId, jobId, text });
}

async function heads(db: AnyDrizzleDb, conversationId: string) {
  return db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      task: agentJobs.task,
      inbox: agentJobs.inbox,
      answersWhileJobId: agentJobs.answersWhileJobId,
      relaunchedFromJobId: agentJobs.relaunchedFromJobId,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(agentJobs.createdAt);
}

async function liveHeads(db: AnyDrizzleDb, conversationId: string) {
  const rows = await heads(db, conversationId);
  return rows.filter((r) => r.status !== 'completed' && r.status !== 'cancelled');
}

/** A tient la tête : son statut terminal posé, commit retenu HOLD_MS. */
function finishHolding(db: ReturnType<typeof createClient>['db'], head: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE agent_jobs SET status = 'completed', updated_at = now() WHERE id = ${head}`,
    );
    await sleep(HOLD_MS);
  });
}

describe('the writers that decide a head of the conversation serialize @cap:parler-par-canal-externe/moteur', () => {
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

  it('1. the terminal write holds the head when a message arrives: the message waits, then starts a head at rest', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      const finish = finishHolding(a.db, head);
      await sleep(150);
      const turn = await send(b.db as unknown as AnyDrizzleDb, conversationId);
      await finish;

      expect(turn.answersWhileJobId).toBeNull();
      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      expect(rows.map((r) => [r.status, r.task, r.answersWhileJobId])).toEqual([
        ['completed', 'Fais-moi un portrait', null],
        ['pending', FOLLOW_UP, null],
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('2. a forward holds the head when the run finishes: the terminal write waits, then the trigger relaunches the message', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      let delivered: Awaited<ReturnType<typeof forward>> | null = null;
      const delivery = a.db.transaction(async (tx) => {
        delivered = await forward(tx as unknown as AnyDrizzleDb, conversationId, head, FOLLOW_UP);
        await sleep(HOLD_MS);
      });
      await sleep(150);
      await b.db
        .update(agentJobs)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(agentJobs.id, head));
      await delivery;

      expect(delivered).toMatchObject({ delivered: true, jobId: head });
      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      expect(rows.map((r) => [r.status, r.task, r.inbox, r.relaunchedFromJobId])).toEqual([
        ['completed', 'Fais-moi un portrait', [], null],
        ['pending', FOLLOW_UP, [], head],
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('3. a message arriving while the head relaunches a NON-empty inbox: a reply turn answering the relaunched head, never a second head at rest (review of #642, pass 1)', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      await forward(a.db as unknown as AnyDrizzleDb, conversationId, head, 'en PNG');
      const finish = finishHolding(a.db, head);
      await sleep(150);
      const turn = await send(b.db as unknown as AnyDrizzleDb, conversationId);
      await finish;

      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      const relaunched = rows.find((r) => r.relaunchedFromJobId === head)!;
      expect(relaunched).toMatchObject({ status: 'pending', task: 'en PNG' });
      expect(turn.answersWhileJobId).toBe(relaunched.id);
      // Aucune tête « au repos » : tout ce qui vit se rattache au travail relancé.
      expect(
        (await liveHeads(a.db as unknown as AnyDrizzleDb, conversationId)).filter(
          (r) => r.answersWhileJobId === null && r.relaunchedFromJobId === null,
        ),
      ).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('4. /stop while the head finishes WITH a waiting message: nothing is left running, and the message is reported discarded', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const { conversationId, head } = await runningHead(a.db as unknown as AnyDrizzleDb);
      await forward(a.db as unknown as AnyDrizzleDb, conversationId, head, 'en PNG');
      const finish = finishHolding(a.db, head);
      await sleep(150);
      const stopped = await stopConversationRuns(b.db as unknown as AnyDrizzleDb, {
        entityId: seed.entityId,
        conversationId,
      });
      await finish;

      expect(await liveHeads(a.db as unknown as AnyDrizzleDb, conversationId)).toEqual([]);
      expect(stopped.stopped.flatMap((r) => r.discardedMessages.map((m) => m.task))).toEqual([
        'en PNG',
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('5. two messages at the same time on an idle conversation: ONE head at rest, and a reply turn answering while it', async () => {
    const a = createClient(harness().url, { max: 1 });
    const b = createClient(harness().url, { max: 1 });
    try {
      const conversationId = await newConversation(a.db as unknown as AnyDrizzleDb);
      const turns: ConversationTurn[] = [];
      const holding = a.db.transaction(async (tx) => {
        turns.push(
          await send(tx as unknown as AnyDrizzleDb, conversationId, 'Fais-moi un portrait'),
        );
        await sleep(HOLD_MS);
      });
      await sleep(150);
      const second = await send(b.db as unknown as AnyDrizzleDb, conversationId);
      await holding;

      expect(turns[0]?.answersWhileJobId).toBeNull();
      expect(second.answersWhileJobId).toBe(turns[0]?.jobId);
      const rows = await heads(a.db as unknown as AnyDrizzleDb, conversationId);
      expect(rows.filter((r) => r.answersWhileJobId === null).map((r) => r.task)).toEqual([
        'Fais-moi un portrait',
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
