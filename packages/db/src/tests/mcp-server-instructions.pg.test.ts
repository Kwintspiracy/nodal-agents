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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Revue Codex passe 4 de #659 : une installation mise à jour garde le cache
// d'outils (v2) de chaque serveur, et ce cache fait choisir la connexion
// PARESSEUSE : le serveur n'est connecté qu'au premier appel d'un de ses
// outils, ses instructions jamais lues avant. Or elles disent justement quel
// outil appeler. La migration invalide donc le cache des serveurs connus
// AVANT elle : le job suivant les connecte une fois (le chemin v1 → v2), et
// lit leurs instructions. Rejouée, elle ne touche plus rien.
describe('0144 sur une installation d’avant @cap:connecter-un-service/moteur', () => {
  const FILE = fileURLToPath(
    new URL('../../migrations/0144_mcp_server_instructions.sql', import.meta.url),
  );

  it('un serveur au cache d’avant est reconnecté une fois ; rejouée, la migration ne touche plus rien', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'mcp-before-0144@exemple.test' })
        .returning({ id: users.id });
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'Before', slug: 'mcp-before-0144' })
        .returning({ id: entities.id });
      const cache = [{ name: 'ping', inputSchema: { type: 'object' } }];

      // L'installation d'avant : pas de colonne, un serveur avec son cache.
      await db.execute(sql`ALTER TABLE mcp_servers DROP COLUMN instructions`);
      await db.execute(
        sql`INSERT INTO mcp_servers (entity_id, name, slug, transport, command, available_tools)
            VALUES (${e!.id}, 'Old', 'old-srv', 'stdio', 'node', ${JSON.stringify(cache)}::jsonb)`,
      );
      const migration = readFileSync(FILE, 'utf8');
      await db.execute(sql.raw(migration));

      const after = (await db.execute(
        sql`SELECT available_tools, instructions FROM mcp_servers WHERE slug = 'old-srv'`,
      )) as unknown as Array<{ available_tools: unknown; instructions: string | null }>;
      expect(after[0]).toEqual({ available_tools: null, instructions: null });

      // Découvert depuis : rejouer le fichier ne l'efface plus.
      await db.execute(
        sql`UPDATE mcp_servers SET available_tools = ${JSON.stringify(cache)}::jsonb
            WHERE slug = 'old-srv'`,
      );
      await db.execute(sql.raw(migration));
      const again = (await db.execute(
        sql`SELECT available_tools FROM mcp_servers WHERE slug = 'old-srv'`,
      )) as unknown as Array<{ available_tools: unknown }>;
      expect(again[0]!.available_tools).toEqual(cache);
    } finally {
      await close();
    }
  });
});
