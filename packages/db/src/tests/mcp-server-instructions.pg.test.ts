// mcp-server-instructions.pg.test.ts — migration 0144 contre un VRAI Postgres.
//
// @cap:connecter-un-service/moteur
//
// `pnpm test` construit sa base depuis le SQL en ligne de `helpers.ts`, jamais
// depuis `migrations/` : une migration absente de `meta/_journal.json` serait
// ignorée EN SILENCE par drizzle-kit pendant que toute la suite reste verte.
// Ce fichier prouve que `mcp_servers.instructions` existe APRÈS les vraies
// migrations, en texte NULLABLE et SANS DÉFAUT (un serveur connecté avant 0144
// n'en reçoit pas d'inventées), et que le schéma Drizzle l'écrit et la relit,
// longue et multiligne, sans la toucher.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, eq, mcpServers, entities, users } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0144_mcp_server_instructions @cap:connecter-un-service/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('instructions existe, en texte NULLABLE et sans défaut', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'mcp_servers'
              AND column_name = 'instructions'`,
      )) as unknown as Array<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>;

      expect(colonnes, 'instructions absente après les vraies migrations').toHaveLength(1);
      expect(colonnes[0]!.data_type).toBe('text');
      expect(colonnes[0]!.is_nullable).toBe('YES');
      expect(colonnes[0]!.column_default).toBeNull();
    } finally {
      await close();
    }
  });

  it('le texte d’un serveur s’écrit et se relit tel quel ; un serveur sans en garde NULL', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'mcp-instructions@exemple.test' })
        .returning({ id: users.id });
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'MCP', slug: 'mcp-instructions' })
        .returning({ id: entities.id });

      // Plus long que le plafond du prompt (4 000) : la base garde tout, c'est
      // le prompt qui coupe.
      const texte = '1. list_printers first.\n2. Then request_print.\n' + 'x'.repeat(6_000);
      const [avec] = await db
        .insert(mcpServers)
        .values({
          entityId: e!.id,
          name: 'Guide',
          slug: 'guide',
          transport: 'stdio',
          command: 'node',
          instructions: texte,
        })
        .returning({ id: mcpServers.id });
      const [sans] = await db
        .insert(mcpServers)
        .values({
          entityId: e!.id,
          name: 'Plain',
          slug: 'plain',
          transport: 'stdio',
          command: 'node',
        })
        .returning({ id: mcpServers.id });

      const relire = async (id: string) =>
        (
          await db
            .select({ instructions: mcpServers.instructions })
            .from(mcpServers)
            .where(eq(mcpServers.id, id))
        )[0]!.instructions;

      expect(await relire(avec!.id)).toBe(texte);
      expect(await relire(sans!.id), 'un serveur sans instructions en a reçu').toBeNull();
    } finally {
      await close();
    }
  });
});
