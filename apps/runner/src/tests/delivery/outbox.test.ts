// tests/delivery/outbox.test.ts
//
// Ce que ces tests prouvent, en lignes RÉELLES de `job_deliveries` et en
// messages RÉELLEMENT reçus par un adaptateur simulé — jamais en nombre
// d'appels :
//
//   - un envoi qui aboutit ferme la ligne avec son reçu, et le claim porte
//     l'identité du runner qui a envoyé ;
//   - un canal qui accuse réception SANS identifiant ferme quand même la ligne
//     (sinon le bail la rendrait et le message partirait deux fois) ;
//   - la borne de trois tentatives vit dans le CLAIM, donc un quatrième drain
//     ne réclame rien du tout ;
//   - le bail vaut exactement 2 × le timeout d'envoi injecté — il est dérivé,
//     pas configuré à côté ;
//   - TOUTE bascule en `rejected` alerte le propriétaire, y compris au premier
//     essai, avec un CODE et des données ;
//   - deux drains simultanés sur la même ligne fraîche ⇒ UN seul envoi ;
//   - aucune credential ne traverse la table.
//
// L'adaptateur est injecté (`adapters`) : aucun réseau, et c'est l'objet même
// que le code de production irait chercher dans le registre.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, agents, agentJobs, jobDeliveries, telegramAllowedChats } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { DeliveryError } from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import {
  DELIVERY_SEND_TIMEOUT_MS,
  deliveryIdempotencyKey,
  drainDeliveries,
  prepareDelivery,
  sweepExhaustedDeliveries,
} from '../../delivery/outbox.ts';
import type { AdapterResolver, DeliveryReceipt } from '../../delivery/outbox.ts';

const BOT_TOKEN = 'test-telegram-token';
const OWNER_CHAT = 'owner-chat-1';
/** Timeout d'envoi injecté ; le bail DOIT en valoir le double (400 ms). */
const T = 200;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

// ─── Adaptateur simulé ────────────────────────────────────────────────────────

interface SentMessage {
  channel: ChannelKind;
  creds: Record<string, string>;
  chatId: string;
  text: string;
}

interface FakeAdapters {
  sent: SentMessage[];
  resolve: AdapterResolver;
  /** Ce que fait `sendText` — remplaçable par test. */
  behave(fn: (m: SentMessage) => Promise<{ messageId: string }>): void;
}

function makeFakeAdapters(): FakeAdapters {
  const sent: SentMessage[] = [];
  let behaviour: (m: SentMessage) => Promise<{ messageId: string }> = async () => ({
    messageId: '42',
  });
  return {
    sent,
    behave(fn) {
      behaviour = fn;
    },
    resolve: (channel: ChannelKind) => ({
      sendText: async (
        creds: Record<string, string>,
        conversationId: string,
        text: string,
      ): Promise<{ messageId: string }> => {
        const message: SentMessage = { channel, creds, chatId: conversationId, text };
        sent.push(message);
        return behaviour(message);
      },
    }),
  };
}

let adapters: FakeAdapters;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let chatSeq = 0;

/** Un job terminal + son chat autorisé, propres à un test. */
async function newDeliverableJob(): Promise<{ jobId: string; chatId: string }> {
  chatSeq += 1;
  const chatId = `chat-${chatSeq}`;
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'task',
      status: 'completed',
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('fixture: job insert returned nothing');

  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId,
    role: 'member',
    status: 'active',
  });

  return { jobId: job.id, chatId };
}

async function prepare(jobId: string, chatId: string, payload = 'le résultat'): Promise<string> {
  const { id } = await prepareDelivery(db as unknown as AnyDrizzleDb, {
    jobId,
    channel: 'telegram',
    chatId,
    payload,
  });
  return id;
}

async function readDelivery(id: string) {
  const [row] = await db.select().from(jobDeliveries).where(eq(jobDeliveries.id, id)).limit(1);
  if (!row) throw new Error(`no delivery row ${id}`);
  return row;
}

/** Force l'expiration du bail sans attendre : le bail est une DATE en base. */
async function expireLease(id: string): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({ claimedAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(jobDeliveries.id, id));
}

async function setOwnerChat(chatId: string | null): Promise<void> {
  await db
    .delete(telegramAllowedChats)
    .where(
      and(eq(telegramAllowedChats.agentId, seed.agentId), eq(telegramAllowedChats.role, 'owner')),
    );
  if (chatId !== null) {
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId,
      role: 'owner',
      status: 'active',
    });
  }
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ telegramBotToken: BOT_TOKEN }).where(eq(agents.id, seed.agentId));
});

beforeEach(async () => {
  adapters = makeFakeAdapters();
  await setOwnerChat(OWNER_CHAT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('drainDeliveries — le chemin nominal', () => {
  it('prepared ⇒ confirmed avec reçu, réclamé par CE runner', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId, 'le texte figé');
    adapters.behave(async () => ({ messageId: '42' }));

    const result = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      runnerInstanceId: 'runner-under-test',
      adapters: adapters.resolve,
    });

    expect(result).toEqual({ sent: 1, rejected: 0, skipped: 0 });

    const row = await readDelivery(id);
    expect(row.outcome).toBe('confirmed');
    expect(row.receipt as DeliveryReceipt).toEqual({ messageId: '42' });
    expect(row.attempts).toBe(1);
    expect(row.claimedBy).toBe('runner-under-test');
    expect(row.claimedAt).not.toBeNull();

    // Le payload envoyé est celui FIGÉ à la préparation, pas une relecture.
    expect(adapters.sent).toHaveLength(1);
    expect(adapters.sent[0]?.text).toBe('le texte figé');
    expect(adapters.sent[0]?.chatId).toBe(chatId);
  });

  it('reçu vide ⇒ confirmed sans messageId, attempts 1', async () => {
    // Décision n°7 : l'appel a résolu sans erreur, c'est l'accusé. Laisser la
    // ligne en `attempted` la ferait reprendre après le bail et livrerait le
    // message une seconde fois.
    for (const emptyish of ['', '0']) {
      const { jobId, chatId } = await newDeliverableJob();
      const id = await prepare(jobId, chatId);
      adapters.behave(async () => ({ messageId: emptyish }));

      await drainDeliveries(db as unknown as AnyDrizzleDb, {
        jobId,
        adapters: adapters.resolve,
      });

      const row = await readDelivery(id);
      expect(row.outcome).toBe('confirmed');
      expect(row.receipt as DeliveryReceipt).toEqual({
        messageId: null,
        reason: 'no_id_returned',
      });
      expect(row.attempts).toBe(1);
    }
  });
});

describe('drainDeliveries — la borne de trois vit dans le claim', () => {
  it('frontière 3/4 : le 4e drain ne réclame rien, le sweep rejette et alerte', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    adapters.behave(async () => {
      throw new DeliveryError('telegram_rate_limited', 'telegram_rate_limited: slow down');
    });

    for (let i = 0; i < 3; i += 1) {
      await drainDeliveries(db as unknown as AnyDrizzleDb, {
        jobId,
        adapters: adapters.resolve,
      });
      await expireLease(id);
    }

    const afterThree = await readDelivery(id);
    expect(afterThree.attempts).toBe(3);
    expect(afterThree.outcome).toBe('attempted');
    expect(adapters.sent).toHaveLength(3);

    // 4e drain : le bail est expiré, mais `attempts < 3` est faux — rien n'est
    // réclamé, l'adaptateur n'est pas rappelé et la ligne ne bouge pas.
    const before = await readDelivery(id);
    const fourth = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      adapters: adapters.resolve,
    });
    expect(fourth).toEqual({ sent: 0, rejected: 0, skipped: 0 });
    expect(adapters.sent).toHaveLength(3);
    const after = await readDelivery(id);
    expect(after.attempts).toBe(3);
    expect(after.outcome).toBe('attempted');
    expect(after.claimedAt?.getTime()).toBe(before.claimedAt?.getTime());

    // Le sweep ferme la ligne ET prévient le propriétaire.
    const swept = await sweepExhaustedDeliveries(db as unknown as AnyDrizzleDb, {
      adapters: adapters.resolve,
    });
    expect(swept.rejected).toBe(1);

    const rejected = await readDelivery(id);
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.receipt as DeliveryReceipt).toEqual({
      messageId: null,
      reason: 'attempts_exhausted',
    });

    const alert = adapters.sent.at(-1);
    expect(alert?.chatId).toBe(OWNER_CHAT);
    expect(alert?.text).toContain('DELIVERY_REJECTED');
    expect(alert?.text).toContain(`job=${jobId}`);
    expect(alert?.text).toContain('attempts=3');
    expect(alert?.text).toContain('reason=attempts_exhausted');
  });
});

describe('drainDeliveries — le bail est DÉRIVÉ du timeout d’envoi', () => {
  it('non réclamable à 2× − 1 ms, réclamable à 2× + 1 ms', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    const key = deliveryIdempotencyKey(jobId, 'telegram', chatId);
    adapters.behave(async () => ({ messageId: '7' }));

    // Une ligne déjà réclamée par un AUTRE runner, dont le bail court encore.
    const claimedAt = new Date();
    await db
      .update(jobDeliveries)
      .set({ outcome: 'attempted', attempts: 1, claimedBy: 'other-runner', claimedAt })
      .where(eq(jobDeliveries.id, id));

    const tooEarly = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      sendTimeoutMs: T,
      now: new Date(claimedAt.getTime() + 2 * T - 1),
      adapters: adapters.resolve,
    });
    expect(tooEarly).toEqual({ sent: 0, rejected: 0, skipped: 0 });
    expect(adapters.sent).toHaveLength(0);
    expect((await readDelivery(id)).claimedBy).toBe('other-runner');

    const justAfter = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      sendTimeoutMs: T,
      now: new Date(claimedAt.getTime() + 2 * T + 1),
      runnerInstanceId: 'taker',
      adapters: adapters.resolve,
    });
    expect(justAfter).toEqual({ sent: 1, rejected: 0, skipped: 0 });
    expect(adapters.sent).toHaveLength(1);

    const row = await readDelivery(id);
    expect(row.claimedBy).toBe('taker');
    expect(row.attempts).toBe(2);
    // La reprise réutilise la MÊME clé : un canal qui la comprend ne double pas.
    expect(row.idempotencyKey).toBe(key);
  });

  it('le budget par défaut est celui du plan (240 s)', () => {
    expect(DELIVERY_SEND_TIMEOUT_MS).toBe(240_000);
  });
});

describe('drainDeliveries — les issues d’envoi', () => {
  it('erreur définitive ⇒ rejected au 1er essai, job intact, owner alerté', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    adapters.behave(async (m) => {
      // L'alerte owner passe par le MÊME adaptateur simulé : seul l'envoi vers
      // le chat de la livraison échoue.
      if (m.chatId === chatId) {
        throw new DeliveryError('telegram_chat_not_found', 'telegram_chat_not_found: gone');
      }
      return { messageId: '99' };
    });

    const result = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      adapters: adapters.resolve,
    });
    expect(result).toEqual({ sent: 0, rejected: 1, skipped: 0 });

    const row = await readDelivery(id);
    expect(row.outcome).toBe('rejected');
    expect(row.attempts).toBe(1);
    expect(row.receipt as DeliveryReceipt).toEqual({
      messageId: null,
      reason: 'telegram_chat_not_found',
    });

    // Le job reste terminal : la livraison a échoué, pas le travail.
    const [job] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    expect(job?.status).toBe('completed');

    // Décision n°8 : l'alerte tombe AU PREMIER essai, pas seulement à
    // l'épuisement — c'est le cas le plus silencieux du système.
    const alert = adapters.sent.find((m) => m.chatId === OWNER_CHAT);
    expect(alert).toBeDefined();
    expect(alert?.text).toContain('DELIVERY_REJECTED');
    expect(alert?.text).toContain(`job=${jobId}`);
    expect(alert?.text).toContain('reason=telegram_chat_not_found');
    expect(alert?.text).toContain('attempts=1');
  });

  it('adaptateur muet ⇒ le drain rend la main, la ligne reste attempted', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapters.behave(() => new Promise<{ messageId: string }>(() => {}));

    const started = Date.now();
    const result = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      sendTimeoutMs: T,
      adapters: adapters.resolve,
    });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ sent: 0, rejected: 0, skipped: 1 });
    // La borne est celle de l'outbox, pas celle de l'adaptateur : il n'en a pas.
    expect(elapsed).toBeLessThan(10 * T);

    const row = await readDelivery(id);
    expect(row.outcome).toBe('attempted');
    expect(row.attempts).toBe(1);

    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('DELIVERY_SEND_ORPHANED');
    expect(logged).toContain(`delivery=${id}`);
  });

  it('owner sans chat ⇒ rejected posé ET DELIVERY_ALERT_NO_OWNER_CHAT journalisé', async () => {
    await setOwnerChat(null);
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapters.behave(async () => {
      throw new DeliveryError('telegram_unauthorized', 'telegram_unauthorized: revoked');
    });

    await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      adapters: adapters.resolve,
    });

    // Le rejet est posé même quand personne n'est joignable : la ligne ne
    // reste pas ouverte en attendant un destinataire d'alerte.
    expect((await readDelivery(id)).outcome).toBe('rejected');

    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('DELIVERY_ALERT_NO_OWNER_CHAT');
    expect(logged).toContain(`job=${jobId}`);
    expect(logged).toContain('cause=no_owner');
    // Aucune alerte n'a pu partir — et surtout, aucune n'est partie ailleurs.
    expect(adapters.sent.filter((m) => m.chatId !== chatId)).toHaveLength(0);
  });
});

describe('drainDeliveries — concurrence', () => {
  it('deux drains sur la même ligne fraîche ⇒ un seul envoi', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    const id = await prepare(jobId, chatId);
    adapters.behave(async () => ({ messageId: '11' }));

    // Les deux drains font leur SELECT avant que l'un ait posé son claim :
    // c'est exactement la course que le claim conditionnel doit trancher.
    const [a, b] = await Promise.all([
      drainDeliveries(db as unknown as AnyDrizzleDb, {
        jobId,
        runnerInstanceId: 'runner-a',
        adapters: adapters.resolve,
      }),
      drainDeliveries(db as unknown as AnyDrizzleDb, {
        jobId,
        runnerInstanceId: 'runner-b',
        adapters: adapters.resolve,
      }),
    ]);

    expect(adapters.sent).toHaveLength(1);
    expect(a.sent + b.sent).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);

    const row = await readDelivery(id);
    expect(row.outcome).toBe('confirmed');
    expect(row.attempts).toBe(1);
    expect(['runner-a', 'runner-b']).toContain(row.claimedBy);
  });
});

describe('drainDeliveries — le tick de reprise (sans jobId)', () => {
  it('reprend TOUTES les livraisons ouvertes, et ne touche pas une ligne déjà confirmée', async () => {
    // Deux jobs dont le drain immédiat n'a jamais eu lieu (processus mort
    // après le commit terminal), et un troisième déjà livré.
    const a = await newDeliverableJob();
    const b = await newDeliverableJob();
    const c = await newDeliverableJob();
    const idA = await prepare(a.jobId, a.chatId, 'résultat A');
    const idB = await prepare(b.jobId, b.chatId, 'résultat B');
    const idC = await prepare(c.jobId, c.chatId, 'résultat C');
    await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId: c.jobId,
      adapters: adapters.resolve,
    });
    expect((await readDelivery(idC)).outcome).toBe('confirmed');
    const sentBefore = adapters.sent.length;

    const result = await drainDeliveries(db as unknown as AnyDrizzleDb, {
      runnerInstanceId: 'runner-tick',
      adapters: adapters.resolve,
    });

    expect(result.sent).toBe(2);
    expect(result.rejected).toBe(0);
    const delivered = adapters.sent.slice(sentBefore).map((m) => [m.chatId, m.text]);
    expect(delivered).toEqual(
      expect.arrayContaining([
        [a.chatId, 'résultat A'],
        [b.chatId, 'résultat B'],
      ]),
    );
    expect(delivered).toHaveLength(2);
    for (const id of [idA, idB]) {
      const row = await readDelivery(id);
      expect(row.outcome).toBe('confirmed');
      expect(row.claimedBy).toBe('runner-tick');
      expect(row.attempts).toBe(1);
    }
    // La ligne confirmée n'a pas été réclamée une seconde fois.
    const rowC = await readDelivery(idC);
    expect(rowC.attempts).toBe(1);
    expect(rowC.claimedBy).not.toBe('runner-tick');
  });
});

describe('prepareDelivery', () => {
  it('clé existante refusée : la seconde préparation lève et ne pose rien', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    await prepare(jobId, chatId);

    await expect(prepare(jobId, chatId)).rejects.toThrow();

    const rows = await db
      .select({ id: jobDeliveries.id })
      .from(jobDeliveries)
      .where(eq(jobDeliveries.jobId, jobId));
    expect(rows).toHaveLength(1);
  });

  it("l'erreur remonte hors de la transaction de l'appelant et la roule", async () => {
    const { jobId, chatId } = await newDeliverableJob();
    await prepare(jobId, chatId);

    await expect(
      db.transaction(async (tx) => {
        // Une écriture quelconque de la « transaction terminale », puis la
        // préparation en doublon : les deux doivent disparaître ensemble.
        await tx.update(agentJobs).set({ result: 'écrit' }).where(eq(agentJobs.id, jobId));
        await prepareDelivery(tx as unknown as AnyDrizzleDb, {
          jobId,
          channel: 'telegram',
          chatId,
          payload: 'doublon',
        });
      }),
    ).rejects.toThrow();

    const [job] = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    expect(job?.result).toBeNull();
  });

  it('aucune credential ne traverse la table', async () => {
    const { jobId, chatId } = await newDeliverableJob();
    await prepare(jobId, chatId);
    adapters.behave(async () => ({ messageId: '5' }));

    await drainDeliveries(db as unknown as AnyDrizzleDb, {
      jobId,
      adapters: adapters.resolve,
    });

    // L'adaptateur a bien REÇU la credential — elle existe donc et transite,
    // mais uniquement en mémoire, au moment d'envoyer.
    expect(adapters.sent[0]?.creds).toEqual({ botToken: BOT_TOKEN });

    const rows = await db.select().from(jobDeliveries).where(eq(jobDeliveries.jobId, jobId));
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(BOT_TOKEN);
    expect(dumped.toLowerCase()).not.toContain('bottoken');
  });
});
