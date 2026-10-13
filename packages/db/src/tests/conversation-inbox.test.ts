// conversation-inbox.test.ts — un message qui arrive pendant que le travail de
// sa conversation tourne (#531), lu dans les lignes en base.
//
// La spécification (Quentin, 30/09) : un tel message n'est jamais sans réponse,
// et il n'est pas PRÉSUMÉ lié au travail en cours. Le mécanisme partagé par
// toutes les entrées :
//   - `startConversationTurn` démarre toujours un job : un TOUR DE RÉPONSE
//     (`answers_while_job_id` = la tête vivante) quel que soit l'état non
//     terminal de la tête, sinon une tête « au repos » ; aucun message n'est
//     versé d'office dans la file du travail en cours ;
//   - `deliverToConversationJob` (l'outil `message_conversation_run`) écrit
//     dans la file d'une tête OU d'un délégué vivant de la conversation ;
//   - le déclencheur de la migration 0141 : ce qui reste dans la file d'une
//     TÊTE qui finit devient une nouvelle tête ; ce qui reste à un délégué est
//     lu par son parent (`drainJobInbox`) ;
//   - `cancelJobTree` (l'arrêt) vide la file sans la relancer, descend dans la
//     tête relancée, et rend les messages retirés.
//
// Mutations vérifiées :
//   - le déclencheur retiré (`DROP TRIGGER` dans helpers.ts) → « what remains
//     in the inbox of a head » rougit (aucune tête née) ;
//   - le déclencheur sans `parent_job_id IS NULL` → « a delegate that finishes »
//     rougit (une tête de l'agent délégué naît) ;
//   - le vidage sans les délégués finis → « read by its parent » rougit ;
//   - la descente par `relaunched_from_job_id` retirée → « stopping a head that
//     has just finished » rougit ;
//   - une ligne NULL tenue pour vivante → « a row WITHOUT a status » rougit ;
//   - (revue de #642, passe 2) le déclencheur limité aux têtes → « a delegate
//     whose head has ALREADY finished » rougit (le message reste sur un job
//     terminal) ; sans les descendants finis → « the parent’s end relaunches
//     it » rougit ; le vidage limité aux enfants directs → « at any depth »
//     rougit ; la décision limitée aux têtes → « a live DELEGATE under a
//     finished head » rougit ; l'arrêt qui ne vide que les jobs vivants → « what
//     a FINISHED delegate left » rougit.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { isInboxMessage } from '@nodal-agents/shared';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agentJobs, codeProjects, conversations } from '../schema/index.ts';
import {
  deliverToConversationJob,
  drainJobInbox,
  pendingHeadsOfConversation,
  startConversationTurn,
} from '../repos/conversation-inbox.ts';
import { cancelJobTree } from '../repos/conversation-runs.ts';
import { recordClaim, withinRunScope } from '../repos/run-claim.ts';
import type { AnyDrizzleDb } from '../client.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let conversationId = '';
let projectId = '';

const any = () => db as unknown as AnyDrizzleDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentJobs);
  const path = `/tmp/p-${crypto.randomUUID()}`;
  const [project] = await db
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: path,
      projectKey: path,
      displayName: 'Portraits',
    })
    .returning({ id: codeProjects.id });
  projectId = project!.id;
  const [conv] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      currentProjectId: projectId,
    })
    .returning({ id: conversations.id });
  conversationId = conv!.id;
});

async function head(status: string | null): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId,
      status,
      task: 'Fais-moi un portrait',
      messages: [{ role: 'user', content: 'Fais-moi un portrait' }],
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function delegate(parentJobId: string, status: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      conversationId,
      parentJobId,
      status,
      task: 'Generate the portrait',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

/** Le message d'un canal, par le point de décision. */
function send(text: string) {
  return startConversationTurn(any(), {
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

/** Ce qu'un tour de réponse transmet au job `jobId`. */
function forward(jobId: string, text: string) {
  return deliverToConversationJob(any(), {
    entityId: seed.entityId,
    conversationId,
    jobId,
    text,
  });
}

async function headsOfConversation() {
  return db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      task: agentJobs.task,
      channel: agentJobs.channel,
      chatId: agentJobs.chatId,
      conversationId: agentJobs.conversationId,
      projectId: agentJobs.projectId,
      messages: agentJobs.messages,
      inbox: agentJobs.inbox,
      answersWhileJobId: agentJobs.answersWhileJobId,
      relaunchedFromJobId: agentJobs.relaunchedFromJobId,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(asc(agentJobs.createdAt));
}

/** Le vidage, fait par le run qui tient la prise 0. */
function drainAsRun(jobId: string) {
  return withinRunScope(jobId, async () => {
    recordClaim(jobId, 0);
    return drainJobInbox(any(), jobId);
  });
}

describe('startConversationTurn — a message while the work runs starts a reply turn @cap:parler-par-canal-externe/moteur', () => {
  it('nothing alive in the conversation: the message starts a head, as before', async () => {
    const turn = await send('Fais-moi un portrait');

    expect(turn.answersWhileJobId).toBeNull();
    expect(await headsOfConversation()).toEqual([
      expect.objectContaining({
        id: turn.jobId,
        status: 'pending',
        task: 'Fais-moi un portrait',
        answersWhileJobId: null,
        inbox: [],
      }),
    ]);
  });

  it.each(['pending', 'processing', 'awaiting_approval', 'awaiting_delegation'])(
    'a head that is %s: the message starts a REPLY TURN answering while it, and nothing lands in its inbox',
    async (status) => {
      const running = await head(status);

      const turn = await send('et mets-le dans le dossier partagé');

      expect(turn.answersWhileJobId).toBe(running);
      const heads = await headsOfConversation();
      expect(heads.map((h) => [h.id, h.status, h.answersWhileJobId, h.inbox])).toEqual([
        [running, status, null, []],
        [turn.jobId, 'pending', running, []],
      ]);
    },
  );

  it.each(['completed', 'failed', 'cancelled'])(
    'a head that is %s holds nothing back: the next message starts a head at rest',
    async (status) => {
      await head(status);

      expect((await send('Et un autre, en couleur')).answersWhileJobId).toBeNull();
    },
  );

  it('a row WITHOUT a status is alive for no path (no writer sets one): the message starts a head at rest (review of #642, pass 1)', async () => {
    // « Vivant » est `LIVE_JOB_STATUSES`, la définition des faucheurs et du
    // déclencheur : une ligne NULL n'est ni fauchée, ni relancée.
    await head(null);

    expect((await send('Fais-moi un portrait')).answersWhileJobId).toBeNull();
  });

  it('no runaway: messages during a reply turn start one reply turn EACH, and a reply turn starts nothing by itself', async () => {
    const running = await head('processing');
    const first = await send('et mets-le dans le dossier partagé');
    // Le tour de réponse tourne ; deux autres messages arrivent.
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, first.jobId));
    const second = await send('en PNG');
    const third = await send('merci');

    const heads = await headsOfConversation();
    // Une tête de travail + trois messages = trois tours, pas un de plus.
    expect(heads).toHaveLength(4);
    expect(heads.map((h) => h.task).sort()).toEqual(
      ['Fais-moi un portrait', 'et mets-le dans le dossier partagé', 'en PNG', 'merci'].sort(),
    );
    // Chacun répond pendant une tête vivante de la conversation ; aucun n'est né
    // d'un autre tour sans message.
    expect(first.answersWhileJobId).toBe(running);
    const vivantes = new Set([running, first.jobId, second.jobId]);
    expect(vivantes.has(second.answersWhileJobId!)).toBe(true);
    expect(vivantes.has(third.answersWhileJobId!)).toBe(true);
    expect(heads.filter((h) => h.answersWhileJobId === null).map((h) => h.id)).toEqual([running]);
  });

  it('a live DELEGATE under a finished head is work running too: the message starts a reply turn answering while it (review of #642, pass 2)', async () => {
    // « Du travail tourne dans la conversation » : n'importe quel job vivant,
    // tête ou délégué. Sans cela, la personne qui écrit pendant que ce délégué
    // tourne tombait sur une tête « au repos », sans le bloc de ce qui tourne.
    const done = await head('failed');
    const zombie = await delegate(done, 'processing');

    expect((await send('Tu en es où ?')).answersWhileJobId).toBe(zombie);
  });

  it('a live head of ANOTHER conversation holds nothing back', async () => {
    const [other] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '9' })
      .returning({ id: conversations.id });
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      conversationId: other!.id,
      status: 'processing',
      task: 'Autre chose',
    });

    expect((await send('Fais-moi un portrait')).answersWhileJobId).toBeNull();
  });
});

describe('deliverToConversationJob — what a reply turn hands to the running work @cap:parler-par-canal-externe/moteur', () => {
  it('writes into the inbox of a live head, and of a live delegate', async () => {
    const running = await head('awaiting_delegation');
    const child = await delegate(running, 'processing');

    expect(await forward(running, 'Range-le dans le dossier partagé à la fin.')).toMatchObject({
      delivered: true,
      jobId: running,
    });
    expect(await forward(child, 'Fais-le en PNG.')).toMatchObject({
      delivered: true,
      jobId: child,
    });

    const rows = await db
      .select({ id: agentJobs.id, inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conversationId));
    const inboxOf = (id: string) => rows.find((r) => r.id === id)!.inbox.map((e) => e.task);
    expect(inboxOf(running)).toEqual(['Range-le dans le dossier partagé à la fin.']);
    expect(inboxOf(child)).toEqual(['Fais-le en PNG.']);
  });

  it('refuses a finished job and a job of another conversation: nothing is written', async () => {
    const done = await head('completed');
    const [other] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', chatId: '9' })
      .returning({ id: conversations.id });
    const [elsewhere] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        conversationId: other!.id,
        status: 'processing',
        task: 'Autre chose',
      })
      .returning({ id: agentJobs.id });

    expect(await forward(done, 'x')).toEqual({
      delivered: false,
      reason: 'not_live',
      status: 'completed',
    });
    expect(await forward(elsewhere!.id, 'x')).toEqual({
      delivered: false,
      reason: 'not_in_conversation',
      status: null,
    });
    const rows = await db.select({ inbox: agentJobs.inbox }).from(agentJobs);
    expect(rows.every((r) => r.inbox.length === 0)).toBe(true);
  });
});

describe('what remains in an inbox when its job finishes is never lost (trigger, migration 0141) @cap:parler-par-canal-externe/moteur', () => {
  it.each(['completed', 'failed', 'cancelled'])(
    'what remains in the inbox of a head that becomes %s: a new pending head carries the first message, its inbox the rest',
    async (status) => {
      const running = await head('processing');
      await forward(running, 'et mets-le dans le dossier partagé');
      await forward(running, 'en PNG');

      // Une écriture de statut quelconque, comme celles des faucheurs : le
      // déclencheur est sur la transition, pas sur un chemin du runner.
      await db.update(agentJobs).set({ status }).where(eq(agentJobs.id, running));

      const heads = await headsOfConversation();
      expect(heads).toHaveLength(2);
      const [ended, relaunched] = heads;
      expect(ended).toMatchObject({ id: running, status, inbox: [] });
      expect(relaunched).toMatchObject({
        status: 'pending',
        task: 'et mets-le dans le dossier partagé',
        channel: 'telegram',
        chatId: '555',
        conversationId,
        // Le projet COURANT de la conversation, comme toute tête qui y naît.
        projectId,
        messages: [{ role: 'user', content: 'et mets-le dans le dossier partagé' }],
        relaunchedFromJobId: running,
        answersWhileJobId: null,
      });
      expect(relaunched!.inbox.map((e) => e.task)).toEqual(['en PNG']);
      expect(await pendingHeadsOfConversation(any(), running)).toEqual([relaunched!.id]);
    },
  );

  it('a delegate that finishes before reading its inbox gives birth to nothing: its parent reads the message on its next turn', async () => {
    const running = await head('awaiting_delegation');
    const child = await delegate(running, 'processing');
    await forward(child, 'Fais-le en PNG.');

    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, child));
    // Aucune tête n'est née de la file du délégué.
    expect((await headsOfConversation()).map((h) => h.id)).toEqual([running]);

    // Le parent reprend la main (reprise de délégation) et lit ce qui restait.
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, running));
    const drained = await drainAsRun(running);

    expect(drained.map((m) => m.content)).toEqual(['Fais-le en PNG.']);
    const [childRow] = await db
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.id, child));
    expect(childRow!.inbox).toEqual([]);
  });

  it('a message passed to a delegate whose head has ALREADY finished is never stranded: when the delegate ends, a new head carries it (review of #642, pass 2)', async () => {
    const done = await head('completed');
    const zombie = await delegate(done, 'processing');
    await forward(zombie, 'Fais-le en PNG.');

    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, zombie));

    const heads = await headsOfConversation();
    expect(heads.map((h) => [h.status, h.task, h.relaunchedFromJobId])).toEqual([
      ['completed', 'Fais-moi un portrait', null],
      ['pending', 'Fais-le en PNG.', done],
    ]);
    const [zombieRow] = await db
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.id, zombie));
    expect(zombieRow!.inbox).toEqual([]);
  });

  it('a delegate that ends under a live parent that then ends without reading: the parent’s end relaunches it (no file stays on a terminal job)', async () => {
    const running = await head('awaiting_delegation');
    const child = await delegate(running, 'processing');
    const grandchild = await delegate(child, 'processing');
    await forward(grandchild, 'Style : encre.');

    // Le petit-enfant finit sous un parent vivant : son message l'attend.
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, grandchild));
    expect((await headsOfConversation()).map((h) => h.id)).toEqual([running]);
    // Le parent finit sans avoir relu, puis la tête : plus aucun lecteur vivant.
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, child));
    await db.update(agentJobs).set({ status: 'failed' }).where(eq(agentJobs.id, running));

    const heads = await headsOfConversation();
    expect(heads.map((h) => [h.status, h.task])).toEqual([
      ['failed', 'Fais-moi un portrait'],
      ['pending', 'Style : encre.'],
    ]);
    const rows = await db
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conversationId));
    expect(rows.filter((r) => r.inbox.length > 0)).toEqual([]);
  });

  it('a live head reads what its FINISHED descendants, at any depth, left in their inbox', async () => {
    const running = await head('awaiting_delegation');
    const child = await delegate(running, 'processing');
    const grandchild = await delegate(child, 'processing');
    await forward(grandchild, 'Style : encre.');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, grandchild));
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, child));

    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, running));
    expect((await drainAsRun(running)).map((m) => m.content)).toEqual(['Style : encre.']);
  });

  it('a non-terminal transition keeps the inbox where it is (suspension, resume)', async () => {
    const running = await head('processing');
    await forward(running, 'et mets-le dans le dossier partagé');

    await db
      .update(agentJobs)
      .set({ status: 'awaiting_approval' })
      .where(eq(agentJobs.id, running));
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, running));

    const heads = await headsOfConversation();
    expect(heads.map((h) => h.id)).toEqual([running]);
    expect(heads[0]!.inbox.map((e) => e.task)).toEqual(['et mets-le dans le dossier partagé']);
  });

  it('a head that finishes with an empty inbox gives birth to nothing', async () => {
    const running = await head('processing');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, running));

    expect((await headsOfConversation()).map((h) => h.id)).toEqual([running]);
  });
});

describe('the stop the person asks for empties the inbox without relaunching it @cap:parler-par-canal-externe/moteur', () => {
  it('cancelJobTree: the head is cancelled, no head is born, and the discarded messages are returned', async () => {
    const running = await head('awaiting_delegation');
    await forward(running, 'et mets-le dans le dossier partagé');

    const out = await cancelJobTree(any(), { entityId: seed.entityId, jobId: running });

    expect(out.jobIds).toEqual([running]);
    expect(out.discardedMessages).toEqual([
      { jobId: running, task: 'et mets-le dans le dossier partagé' },
    ]);
    const heads = await headsOfConversation();
    expect(heads.map((h) => ({ id: h.id, status: h.status, inbox: h.inbox }))).toEqual([
      { id: running, status: 'cancelled', inbox: [] },
    ]);
  });

  it('stopping a head also discards what a FINISHED delegate left for it: nothing is relaunched after the stop (review of #642, pass 2)', async () => {
    const running = await head('awaiting_delegation');
    const child = await delegate(running, 'processing');
    await forward(child, 'Style : encre.');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, child));

    const out = await cancelJobTree(any(), { entityId: seed.entityId, jobId: running });

    expect(out.discardedMessages).toEqual([{ jobId: child, task: 'Style : encre.' }]);
    expect((await headsOfConversation()).map((h) => [h.id, h.status])).toEqual([
      [running, 'cancelled'],
    ]);
    const rows = await db
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conversationId));
    expect(rows.filter((r) => r.inbox.length > 0)).toEqual([]);
  });

  it('stopping a head that has just finished also stops the head its inbox relaunched: the same work (review of #642, pass 1)', async () => {
    const running = await head('processing');
    await forward(running, 'et mets-le dans le dossier partagé');
    await forward(running, 'en PNG');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, running));
    const relaunched = (await headsOfConversation()).find((h) => h.id !== running)!;

    const out = await cancelJobTree(any(), { entityId: seed.entityId, jobId: running });

    expect(out.jobIds).toEqual([relaunched.id]);
    expect(out.discardedMessages).toEqual([
      { jobId: relaunched.id, task: 'et mets-le dans le dossier partagé' },
      { jobId: relaunched.id, task: 'en PNG' },
    ]);
    expect((await headsOfConversation()).map((h) => [h.id, h.status, h.inbox])).toEqual([
      [running, 'completed', []],
      [relaunched.id, 'cancelled', []],
    ]);
  });
});

describe('drainJobInbox — only the run that holds the job reads its inbox @cap:parler-par-canal-externe/moteur', () => {
  it('under its claim: returns the messages marked as delivered, empties the inbox, appends them to the transcript', async () => {
    const running = await head('processing');
    await forward(running, 'et mets-le dans le dossier partagé');

    const drained = await drainAsRun(running);

    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      role: 'user',
      content: 'et mets-le dans le dossier partagé',
    });
    expect(isInboxMessage(drained[0])).toBe(true);
    const [row] = await headsOfConversation();
    expect(row!.inbox).toEqual([]);
    expect(row!.messages).toEqual([{ role: 'user', content: 'Fais-moi un portrait' }, drained[0]]);
  });

  it('under a claim another run has taken since: reads nothing, the inbox stays for the run that holds it', async () => {
    const running = await head('processing');
    await db.update(agentJobs).set({ claimGeneration: 2 }).where(eq(agentJobs.id, running));
    await forward(running, 'et mets-le dans le dossier partagé');

    const drained = await withinRunScope(running, async () => {
      recordClaim(running, 1);
      return drainJobInbox(any(), running);
    });

    expect(drained).toEqual([]);
    const [row] = await headsOfConversation();
    expect(row!.inbox.map((e) => e.task)).toEqual(['et mets-le dans le dossier partagé']);
  });
});
