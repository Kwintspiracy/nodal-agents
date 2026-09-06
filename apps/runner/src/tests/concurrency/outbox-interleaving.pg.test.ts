// outbox-interleaving.pg.test.ts — l'outbox de livraison sous VRAIE
// concurrence : deux connexions Postgres, deux drains, une ligne.
//
// Sur PGlite (une connexion), « deux drains simultanés » est un mensonge
// tranquille : le second attend la fin du premier. Ici (plan « Vérifier &
// Corriger », T14) le claim `UPDATE … RETURNING` est éprouvé pour de vrai :
//
//   - deux drains concurrents sur la même ligne fraîche ⇒ UN envoi ;
//   - la borne de trois tentatives sous contention : deux connexions
//     alternent les claims avec bail expiré, `attempts` atteint 3, le 4e tour
//     ne réclame rien sur aucune des deux ;
//   - la frontière du bail : non réclamable à 2×T − 1, réclamable à 2×T + 1.
//
// Le démarrage du harnais est un TEST (rouge si le binaire manque, jamais
// sauté — inv. #4).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  agents,
  agentJobs,
  jobDeliveries,
  telegramAllowedChats,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { seedMinimal, type TestDb } from '@nodal-agents/db/test-utils';
import type { ChannelKind } from '@nodal-agents/delivery';
import {
  drainDeliveries,
  prepareDelivery,
  sweepExhaustedDeliveries,
} from '../../delivery/outbox.ts';
import type { AdapterResolver } from '../../delivery/outbox.ts';

let pg: RealPostgres | null = null;
let a: ReturnType<typeof createClient> | null = null;
let b: ReturnType<typeof createClient> | null = null;
let seed: { userId: string; entityId: string; agentId: string; jobId: string } | null = null;

const BOT_TOKEN = 'test-telegram-token';
let chatSeq = 0;

afterAll(async () => {
  await a?.close();
  await b?.close();
  await pg?.stop();
});

function harness() {
  if (!pg || !a || !b || !seed)
    expect.fail('REAL_POSTGRES_NOT_STARTED — le démarrage a échoué avant');
  return { a: a.db as unknown as AnyDrizzleDb, b: b.db as unknown as AnyDrizzleDb, seed };
}

/** Un adaptateur qui compte, et dont le comportement est remplaçable. */
function makeAdapters(behave: () => Promise<{ messageId: string }>) {
  let sends = 0;
  const resolve: AdapterResolver = (_channel: ChannelKind) => ({
    sendText: async () => {
      sends += 1;
      return behave();
    },
  });
  return { resolve, sends: () => sends };
}

async function newDelivery(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
): Promise<{ jobId: string; chatId: string; id: string }> {
  chatSeq += 1;
  const chatId = `chat-t14-${chatSeq}`;
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'api',
      task: 'task',
      status: 'completed',
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  await db.insert(telegramAllowedChats).values({
    entityId,
    agentId,
    chatId,
    role: 'member',
    status: 'active',
  });
  const { id } = await prepareDelivery(db, {
    jobId: job.id,
    channel: 'telegram',
    chatId,
    payload: 'le résultat',
  });
  return { jobId: job.id, chatId, id };
}

async function row(db: AnyDrizzleDb, id: string) {
  const [r] = await db
    .select({
      outcome: jobDeliveries.outcome,
      attempts: jobDeliveries.attempts,
      claimedBy: jobDeliveries.claimedBy,
      receipt: jobDeliveries.receipt,
    })
    .from(jobDeliveries)
    .where(eq(jobDeliveries.id, id));
  if (!r) throw new Error('delivery row missing');
  return r;
}

describe('harnais', () => {
  it('démarre Postgres, applique les vraies migrations, ouvre deux connexions', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    a = createClient(pg.url, { max: 1 });
    b = createClient(pg.url, { max: 1 });
    seed = await seedMinimal(a.db as unknown as TestDb);
    await a.db
      .update(agents)
      .set({ telegramBotToken: BOT_TOKEN })
      .where(eq(agents.id, seed.agentId));
  }, 120_000);
});

describe('outbox sous vraie concurrence', () => {
  it('deux drains concurrents sur la même ligne fraîche ⇒ exactement UN envoi, une ligne confirmed, attempts 1', async () => {
    const h = harness();
    const d = await newDelivery(h.a, h.seed.entityId, h.seed.agentId);
    const adapters = makeAdapters(async () => {
      // Assez long pour que les deux drains se chevauchent réellement.
      await new Promise((r) => setTimeout(r, 300));
      return { messageId: '42' };
    });

    // Les deux connexions sont chauffées : sans cela, la première requête de
    // la connexion froide part après le claim de l'autre, et la course n'a
    // pas lieu (le second drain ne verrait aucune candidate).
    await Promise.all([row(h.a, d.id), row(h.b, d.id)]);

    const [ra, rb] = await Promise.all([
      drainDeliveries(h.a, {
        jobId: d.jobId,
        runnerInstanceId: 'runner-A',
        adapters: adapters.resolve,
      }),
      drainDeliveries(h.b, {
        jobId: d.jobId,
        runnerInstanceId: 'runner-B',
        adapters: adapters.resolve,
      }),
    ]);

    expect(adapters.sends()).toBe(1);
    expect(ra.sent + rb.sent).toBe(1);
    // Le perdant a vu la candidate et perdu l'UPDATE (skipped 1), ou l'a vue
    // déjà réclamée (skipped 0) — jamais envoyée deux fois.
    expect(ra.skipped + rb.skipped).toBeLessThanOrEqual(1);
    const r = await row(h.a, d.id);
    expect(r.outcome).toBe('confirmed');
    expect(r.attempts).toBe(1);
    expect(['runner-A', 'runner-B']).toContain(r.claimedBy);
    expect(r.receipt).toEqual({ messageId: '42' });
  }, 30_000);

  it('frontière 3/4 sous contention : deux connexions alternent les claims à bail expiré ⇒ attempts atteint 3, le 4e tour ne réclame rien ; le sweep ferme', async () => {
    const h = harness();
    const d = await newDelivery(h.a, h.seed.entityId, h.seed.agentId);
    const adapters = makeAdapters(async () => {
      throw new Error('transient network error');
    });
    const T = 200;
    const base = Date.now();
    const claimsPerRound: number[] = [];

    for (let round = 1; round <= 4; round++) {
      // Chaque tour, le bail du précédent est expiré (now avance de 10 min).
      const now = new Date(base + round * 10 * 60_000);
      const [ra, rb] = await Promise.all([
        drainDeliveries(h.a, {
          jobId: d.jobId,
          runnerInstanceId: 'runner-A',
          adapters: adapters.resolve,
          sendTimeoutMs: T,
          now,
        }),
        drainDeliveries(h.b, {
          jobId: d.jobId,
          runnerInstanceId: 'runner-B',
          adapters: adapters.resolve,
          sendTimeoutMs: T,
          now,
        }),
      ]);
      // Un claim au plus par tour : l'autre connexion a vu la ligne mais
      // n'a pas gagné l'UPDATE.
      const claims = (await row(h.a, d.id)).attempts;
      claimsPerRound.push(claims);
      expect(ra.sent + rb.sent).toBe(0);
    }

    expect(claimsPerRound).toEqual([1, 2, 3, 3]);
    expect(adapters.sends()).toBe(3);
    const before = await row(h.a, d.id);
    expect(before.outcome).toBe('attempted');
    expect(before.attempts).toBe(3);

    // Le sweep, bail expiré : rejected, et il n'y a plus rien à réclamer.
    const swept = await sweepExhaustedDeliveries(h.b, {
      sendTimeoutMs: T,
      now: new Date(base + 5 * 10 * 60_000),
      adapters: adapters.resolve,
    });
    expect(swept.rejected).toBeGreaterThanOrEqual(1);
    const after = await row(h.a, d.id);
    expect(after.outcome).toBe('rejected');
    expect(after.attempts).toBe(3);
  }, 30_000);

  it('frontière du bail : non réclamable à 2×T − 1 ms, réclamable à 2×T + 1 ms — sur l’autre connexion', async () => {
    const h = harness();
    const d = await newDelivery(h.a, h.seed.entityId, h.seed.agentId);
    const T = 200;
    const t0 = new Date(Date.now());
    // Premier claim par A, adaptateur muet (timeout) : la ligne reste attempted.
    const mute = makeAdapters(() => new Promise(() => {}));
    const first = await drainDeliveries(h.a, {
      jobId: d.jobId,
      runnerInstanceId: 'runner-A',
      adapters: mute.resolve,
      sendTimeoutMs: T,
      now: t0,
    });
    expect(first.skipped).toBe(1);
    expect((await row(h.a, d.id)).outcome).toBe('attempted');

    const ok = makeAdapters(async () => ({ messageId: '7' }));
    const early = await drainDeliveries(h.b, {
      jobId: d.jobId,
      runnerInstanceId: 'runner-B',
      adapters: ok.resolve,
      sendTimeoutMs: T,
      now: new Date(t0.getTime() + 2 * T - 1),
    });
    expect(early.sent).toBe(0);
    expect(ok.sends()).toBe(0);

    const late = await drainDeliveries(h.b, {
      jobId: d.jobId,
      runnerInstanceId: 'runner-B',
      adapters: ok.resolve,
      sendTimeoutMs: T,
      now: new Date(t0.getTime() + 2 * T + 1),
    });
    expect(late.sent).toBe(1);
    expect(ok.sends()).toBe(1);
    const r = await row(h.a, d.id);
    expect(r.outcome).toBe('confirmed');
    expect(r.attempts).toBe(2);
    expect(r.claimedBy).toBe('runner-B');
  }, 30_000);
});
