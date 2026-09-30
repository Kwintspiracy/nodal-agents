// conversation-inbox.test.ts — UN travail de tête par conversation (#531).
//
// Sur Telegram, Discord, Slack et WhatsApp, chaque message insérait un job de
// tête : une précision envoyée pendant que la première demande tournait
// (« et mets-le dans le dossier partagé ») relançait tout le travail. Ici, le
// mécanisme partagé par toutes les entrées, lu dans les lignes en base :
//   - `deliverOrStartTurn` : une tête vivante, QUEL QUE SOIT son état non
//     terminal (pas prise, en cours, suspendue pour une approbation ou une
//     délégation, sans statut), reçoit le message dans sa file ; sinon le
//     message démarre une tête, comme avant ;
//   - le déclencheur de la migration 0141 : ce qui reste en file quand la tête
//     devient terminale — quel que soit l'écrivain de la transition — devient
//     une nouvelle tête qui le porte ;
//   - `cancelJobTree` (l'arrêt demandé par la personne) vide la file sans la
//     relancer, et le rend ;
//   - `drainJobInbox` ne vide la file que sous la prise du run qui tient le job.
//
// Mutations vérifiées :
//   - le déclencheur retiré (`DROP TRIGGER` dans helpers.ts) → « ce qui reste en
//     file… » rougit sur les trois statuts terminaux (aucune tête née) ;
//   - la tête cherchée sans `notTerminal()` → « une tête TERMINÉE ne retient
//     rien » rougit (le message part dans la file d'un job fini) ;
//   - `inbox` non vidé par `cancelJobTree` → « l'arrêt vide la file » rougit
//     (une tête naît de l'arrêt) ;
//   - (revue de #642, passe 1) la descente par `relaunched_from_job_id`
//     retirée → « stopping a head that has just finished » rougit ; le vidage
//     qui lit aussi les entrées en préparation → « while the photo downloads »
//     rougit ; une ligne NULL tenue pour vivante → « a row WITHOUT a status »
//     rougit.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { INBOX_MEDIA_WAIT_MS, isInboxMessage } from '@nodal-agents/shared';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agentJobs, codeProjects, conversations } from '../schema/index.ts';
import {
  attachToInboxEntry,
  deliverOrStartTurn,
  drainJobInbox,
  pendingHeadsOfConversation,
  releaseInboxEntry,
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

/** Le message d'un canal : démarrer ce job-là, ou le remettre à la tête vivante. */
function send(text: string) {
  return deliverOrStartTurn(any(), {
    entityId: seed.entityId,
    conversationId,
    message: { task: text, content: text },
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
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(asc(agentJobs.createdAt));
}

describe('deliverOrStartTurn — one head job per conversation @cap:parler-par-canal-externe/moteur', () => {
  it('nothing alive in the conversation: the message starts a job, as before', async () => {
    const turn = await send('Fais-moi un portrait');

    expect(turn.kind).toBe('started');
    const heads = await headsOfConversation();
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      id: turn.kind === 'started' ? turn.jobId : '',
      status: 'pending',
      task: 'Fais-moi un portrait',
      inbox: [],
    });
  });

  it.each(['pending', 'processing', 'awaiting_approval', 'awaiting_delegation'])(
    'a head that is %s receives the message in its inbox: no second job',
    async (status) => {
      const running = await head(status);

      const turn = await send('et mets-le dans le dossier partagé');

      expect(turn).toEqual({
        kind: 'delivered',
        headJobId: running,
        entryId: expect.any(String) as string,
      });
      const heads = await headsOfConversation();
      expect(heads.map((h) => h.id)).toEqual([running]);
      expect(heads[0]!.status).toBe(status);
      expect(heads[0]!.inbox).toEqual([
        {
          id: turn.kind === 'delivered' ? turn.entryId : '',
          task: 'et mets-le dans le dossier partagé',
          content: 'et mets-le dans le dossier partagé',
          receivedAt: expect.any(String) as string,
        },
      ]);
    },
  );

  it.each(['completed', 'failed', 'cancelled'])(
    'a head that is %s holds nothing back: the next message starts a job',
    async (status) => {
      const done = await head(status);

      const turn = await send('Et un autre, en couleur');

      expect(turn.kind).toBe('started');
      const heads = await headsOfConversation();
      expect(heads.map((h) => h.task)).toEqual(['Fais-moi un portrait', 'Et un autre, en couleur']);
      expect(heads.find((h) => h.id === done)!.inbox).toEqual([]);
    },
  );

  it('a row WITHOUT a status is alive for no path (no writer sets one): the message starts a job (review of #642, pass 1)', async () => {
    // La définition de « vivant » est celle des faucheurs et du déclencheur
    // (`LIVE_JOB_STATUSES`) : une ligne NULL n'est ni fauchée, ni relancée —
    // lui remettre un message l'y enfermerait.
    await head(null);

    expect((await send('Fais-moi un portrait')).kind).toBe('started');
  });

  it('a live DELEGATE under a finished head is not a head: the message starts a job', async () => {
    const done = await head('failed');
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      conversationId,
      parentJobId: done,
      status: 'processing',
      task: 'Generate the portrait',
    });

    expect((await send('Tu en es où ?')).kind).toBe('started');
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

    expect((await send('Fais-moi un portrait')).kind).toBe('started');
  });
});

describe('what remains in the inbox when the head finishes becomes a new head (trigger, migration 0141) @cap:parler-par-canal-externe/moteur', () => {
  it.each(['completed', 'failed', 'cancelled'])(
    'a head that becomes %s with two waiting messages: a new pending head carries the first, its inbox the second',
    async (status) => {
      const running = await head('processing');
      await send('et mets-le dans le dossier partagé');
      await send('en PNG');

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
      });
      expect(relaunched!.inbox.map((e) => e.task)).toEqual(['en PNG']);
      expect(await pendingHeadsOfConversation(any(), running)).toEqual([relaunched!.id]);
    },
  );

  it('a non-terminal transition keeps the inbox where it is (suspension, resume)', async () => {
    const running = await head('processing');
    await send('et mets-le dans le dossier partagé');

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
    await send('et mets-le dans le dossier partagé');

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

  it('stopping a head that has just finished also stops the head its inbox relaunched: the same work (review of #642, pass 1)', async () => {
    const running = await head('processing');
    await send('et mets-le dans le dossier partagé');
    await send('en PNG');
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

/** Le vidage, fait par le run qui tient la prise 0. */
function drainAsRun(jobId: string) {
  return withinRunScope(jobId, async () => {
    recordClaim(jobId, 0);
    return drainJobInbox(any(), jobId);
  });
}

describe('drainJobInbox — only the run that holds the job reads its inbox @cap:parler-par-canal-externe/moteur', () => {
  it('under its claim: returns the messages marked as delivered, empties the inbox, appends them to the transcript', async () => {
    const running = await head('processing');
    await send('et mets-le dans le dossier partagé');

    const drained = await drainAsRun(running);

    expect(drained.preparing).toBe(0);
    expect(drained.messages).toHaveLength(1);
    expect(drained.messages[0]).toMatchObject({
      role: 'user',
      content: 'et mets-le dans le dossier partagé',
    });
    expect(isInboxMessage(drained.messages[0])).toBe(true);
    const [row] = await headsOfConversation();
    expect(row!.inbox).toEqual([]);
    expect(row!.messages).toEqual([
      { role: 'user', content: 'Fais-moi un portrait' },
      drained.messages[0],
    ]);
  });

  it('under a claim another run has taken since: reads nothing, the inbox stays for the run that holds it', async () => {
    const running = await head('processing');
    await db.update(agentJobs).set({ claimGeneration: 2 }).where(eq(agentJobs.id, running));
    await send('et mets-le dans le dossier partagé');

    const drained = await withinRunScope(running, async () => {
      recordClaim(running, 1);
      return drainJobInbox(any(), running);
    });

    expect(drained.messages).toEqual([]);
    const [row] = await headsOfConversation();
    expect(row!.inbox.map((e) => e.task)).toEqual(['et mets-le dans le dossier partagé']);
  });
});

/** Un message dont le canal télécharge encore la photo : remis « en préparation ». */
function sendWithPhoto(text: string) {
  return deliverOrStartTurn(any(), {
    entityId: seed.entityId,
    conversationId,
    message: { task: text, content: text, preparing: true },
    start: {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      conversationId,
      task: text,
    },
  });
}

const PHOTO = [
  { type: 'text' as const, text: 'dans ce style' },
  { type: 'image' as const, image: '/ws/shared/telegram/555/x.jpg' },
];

describe('a delivered message is never read before its media is attached (review of #642, pass 1) @cap:parler-par-canal-externe/moteur', () => {
  it('while the photo downloads the entry stays in the inbox, counted; once attached it is read WITH the photo', async () => {
    const running = await head('processing');
    const turn = await sendWithPhoto('dans ce style');
    if (turn.kind !== 'delivered') throw new Error('expected a delivery');
    await send('et en couleur');

    const before = await drainAsRun(running);
    // Le message sans média passe ; celui dont la photo arrive attend.
    expect(before.messages.map((m) => m.content)).toEqual(['et en couleur']);
    expect(before.preparing).toBe(1);
    expect((await headsOfConversation())[0]!.inbox.map((e) => e.task)).toEqual(['dans ce style']);

    expect(
      await attachToInboxEntry(any(), {
        entityId: seed.entityId,
        entryId: turn.entryId,
        content: PHOTO,
      }),
    ).toBe(true);
    const after = await drainAsRun(running);

    expect(after).toEqual({
      messages: [expect.objectContaining({ content: PHOTO })],
      preparing: 0,
    });
    // Une fois lue, l'entrée n'attend plus nulle part.
    expect(
      await attachToInboxEntry(any(), {
        entityId: seed.entityId,
        entryId: turn.entryId,
        content: PHOTO,
      }),
    ).toBe(false);
  });

  it('a failed download releases the entry: read text-only at once', async () => {
    const running = await head('processing');
    const turn = await sendWithPhoto('dans ce style');
    if (turn.kind !== 'delivered') throw new Error('expected a delivery');

    expect(await releaseInboxEntry(any(), { entityId: seed.entityId, entryId: turn.entryId })).toBe(
      true,
    );

    expect(await drainAsRun(running)).toEqual({
      messages: [expect.objectContaining({ content: 'dans ce style' })],
      preparing: 0,
    });
  });

  it('a download that never ends does not hold the message forever: past INBOX_MEDIA_WAIT_MS it is read as it is', async () => {
    const running = await head('processing');
    await db
      .update(agentJobs)
      .set({
        inbox: [
          {
            id: crypto.randomUUID(),
            task: 'dans ce style',
            content: 'dans ce style',
            receivedAt: new Date(Date.now() - INBOX_MEDIA_WAIT_MS - 1_000).toISOString(),
            preparing: true,
          },
        ],
      })
      .where(eq(agentJobs.id, running));

    expect((await drainAsRun(running)).messages.map((m) => m.content)).toEqual(['dans ce style']);
  });

  it('the photo reaches its entry even after the head finished and the trigger moved it to the relaunched head', async () => {
    const running = await head('processing');
    await send('et mets-le dans le dossier partagé');
    const turn = await sendWithPhoto('dans ce style');
    if (turn.kind !== 'delivered') throw new Error('expected a delivery');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, running));

    expect(
      await attachToInboxEntry(any(), {
        entityId: seed.entityId,
        entryId: turn.entryId,
        content: PHOTO,
      }),
    ).toBe(true);
    const relaunched = (await headsOfConversation()).find((h) => h.id !== running)!;
    expect(relaunched.inbox.map((e) => [e.content, e.preparing])).toEqual([[PHOTO, undefined]]);
  });
});
