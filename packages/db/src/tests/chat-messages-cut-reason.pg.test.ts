// chat-messages-cut-reason.pg.test.ts — migration 0124 sur un VRAI Postgres (#458).
//
// `spinUpTestDb` construit sa base en SQL écrit à la main : une migration
// absente du journal y passerait inaperçue. Ce test applique les VRAIES
// migrations, et prouve que la colonne arrive avec ce que le runner écrit.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0124_chat_messages_cut_reason @cap:parler-a-un-agent/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('chat_messages.cut_reason existe : texte, facultatif, NULL par défaut', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'chat_messages'
              AND column_name = 'cut_reason'`,
      )) as unknown as Array<{ data_type: string; is_nullable: string; column_default: string }>;
      expect(colonnes).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    } finally {
      await close();
    }
  });
});
