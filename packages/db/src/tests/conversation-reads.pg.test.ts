// conversation-reads.pg.test.ts — migration 0112 contre un VRAI Postgres.
//
// @cap:reprendre-conversation/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou, pire, absente de `meta/_journal.json`, ce qui la fait
// ignorer EN SILENCE par drizzle-kit — pendant que toute la suite reste verte,
// et seule une vraie mise à jour casse.
//
// Ce que ce fichier prouve, et que la base de test ne prouverait pas : la
// table existe APRÈS les vraies migrations, sa clé primaire est le couple
// (personne, fil) — donc un second marqueur de la même personne sur le même
// fil AVANCE le premier au lieu de s'empiler — et les deux cascades emportent
// les marqueurs quand le fil ou la personne disparaît.
//
// Mutation vérifiée : l'entrée 112 retirée de `meta/_journal.json` → le second
// test rougit (« conversation_reads absente après les vraies migrations »).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  and,
  eq,
  agents,
  conversationReads,
  conversations,
  entities,
  users,
} from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Les identités semées par le troisième test, relues par les suivants. */
const seme = { userId: '', entityId: '', agentId: '', conversationId: '' };

describe('migration 0112_conversation_reads @cap:reprendre-conversation/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('conversation_reads existe, et sa clé primaire est (user_id, conversation_id)', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'conversation_reads'
            ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;

      expect(
        colonnes.map((c) => c.column_name),
        'conversation_reads absente après les vraies migrations',
      ).toEqual(['conversation_id', 'read_at', 'user_id']);
      expect(colonnes.every((c) => c.is_nullable === 'NO')).toBe(true);
      expect(colonnes.find((c) => c.column_name === 'read_at')?.data_type).toBe(
        'timestamp with time zone',
      );

      const cle = (await db.execute(
        sql`SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'conversation_reads'::regclass AND i.indisprimary
            ORDER BY a.attname`,
      )) as unknown as Array<{ column_name: string }>;
      expect(cle.map((c) => c.column_name)).toEqual(['conversation_id', 'user_id']);
    } finally {
      await close();
    }
  });

  it('un second marqueur de la même personne AVANCE le premier, il ne s’empile pas', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'lecteur@exemple.test' })
        .returning({ id: users.id });
      seme.userId = u!.id;
      const [e] = await db
        .insert(entities)
        .values({ userId: seme.userId, name: 'Lecture', slug: 'lecture' })
        .returning({ id: entities.id });
      seme.entityId = e!.id;
      const [a] = await db
        .insert(agents)
        .values({
          entityId: seme.entityId,
          name: 'Agent',
          slug: 'agent-lecture',
          personality: '',
        })
        .returning({ id: agents.id });
      seme.agentId = a!.id;
      const [c] = await db
        .insert(conversations)
        .values({ entityId: seme.entityId, agentId: seme.agentId, title: 'Un fil' })
        .returning({ id: conversations.id });
      seme.conversationId = c!.id;

      const tot = new Date('2026-09-19T08:00:00.000Z');
      const tard = new Date('2026-09-19T18:30:00.000Z');
      await db
        .insert(conversationReads)
        .values({ userId: seme.userId, conversationId: seme.conversationId, readAt: tot });
      await db
        .insert(conversationReads)
        .values({ userId: seme.userId, conversationId: seme.conversationId, readAt: tard })
        .onConflictDoUpdate({
          target: [conversationReads.userId, conversationReads.conversationId],
          set: { readAt: tard },
        });

      const lignes = await db
        .select({ readAt: conversationReads.readAt })
        .from(conversationReads)
        .where(
          and(
            eq(conversationReads.userId, seme.userId),
            eq(conversationReads.conversationId, seme.conversationId),
          ),
        );
      expect(lignes, 'deux marqueurs pour la même personne sur le même fil').toHaveLength(1);
      expect(lignes[0]!.readAt.toISOString()).toBe('2026-09-19T18:30:00.000Z');
    } finally {
      await close();
    }
  });

  it('le fil supprimé emporte ses marqueurs', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.delete(conversations).where(eq(conversations.id, seme.conversationId));
      const restants = await db
        .select({ readAt: conversationReads.readAt })
        .from(conversationReads)
        .where(eq(conversationReads.conversationId, seme.conversationId));
      expect(restants, 'un marqueur a survécu à son fil').toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('la personne supprimée emporte ses marqueurs', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [c] = await db
        .insert(conversations)
        .values({ entityId: seme.entityId, agentId: seme.agentId, title: 'Un autre fil' })
        .returning({ id: conversations.id });
      await db.insert(conversationReads).values({ userId: seme.userId, conversationId: c!.id });
      await db.delete(users).where(eq(users.id, seme.userId));

      const restants = await db
        .select({ readAt: conversationReads.readAt })
        .from(conversationReads)
        .where(eq(conversationReads.conversationId, c!.id));
      expect(restants, 'un marqueur a survécu à son lecteur').toHaveLength(0);
    } finally {
      await close();
    }
  });
});
