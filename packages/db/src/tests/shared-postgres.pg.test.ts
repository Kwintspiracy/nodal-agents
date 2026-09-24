// shared-postgres.pg.test.ts — les fichiers `.pg` partagent UN serveur par run,
// chacun sur sa base (#471).
//
// @cap:verifier-un-livrable/moteur
//
// Ce que ça prouve, contre le vrai serveur du run :
//   - `startRealPostgres()` ne démarre plus de cluster : il rend une base sur le
//     serveur que le `globalSetup` du projet `pg` a démarré (même port) ;
//   - deux bases ne se voient pas : une table créée dans l'une n'existe pas
//     dans l'autre ;
//   - `stop()` supprime la base, et seulement elle : le serveur répond encore.
//
// Sans le serveur partagé, chaque fichier refaisait `initdb` : dix-huit
// démarrages que le verrou de la machine ne tenait plus en file au-delà de
// 45 s, et un fichier `.pg` au hasard qui rougissait dans la suite complète.

import { describe, it, expect, afterAll, inject } from 'vitest';
import { startRealPostgres, SHARED_POSTGRES_KEY, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';

const handles: RealPostgres[] = [];

afterAll(async () => {
  for (const h of handles) await h.stop();
});

async function query<T>(url: string, text: ReturnType<typeof sql>): Promise<T[]> {
  const { db, close } = createClient(url, { max: 1 });
  try {
    return (await db.execute(text)) as unknown as T[];
  } finally {
    await close();
  }
}

function databaseOf(url: string): string {
  return new URL(url).pathname.slice(1);
}

describe('un serveur Postgres par run, une base par fichier @cap:verifier-un-livrable/moteur', () => {
  it('startRealPostgres rend une base sur le serveur du run, pas un cluster neuf', async () => {
    const shared = inject(SHARED_POSTGRES_KEY);
    expect(shared, 'le projet pg ne fournit pas de serveur : son globalSetup manque').toBeDefined();

    const a = await startRealPostgres();
    handles.push(a);
    expect(a.port).toBe(shared!.port);
    expect(a.dataDir).toBe(shared!.dataDir);
  }, 60_000);

  it('deux bases du même serveur ne se voient pas, et stop() ne supprime que la sienne', async () => {
    const a = await startRealPostgres();
    const b = await startRealPostgres();
    handles.push(a, b);
    expect(databaseOf(a.url)).not.toBe(databaseOf(b.url));

    await query(a.url, sql`CREATE TABLE seulement_dans_a (id int)`);
    const dansB = await query<{ n: number }>(
      b.url,
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'seulement_dans_a'`,
    );
    expect(dansB[0]!.n).toBe(0);

    await a.stop();
    const restantes = await query<{ datname: string }>(
      b.url,
      sql`SELECT datname FROM pg_database WHERE datname IN (${databaseOf(a.url)}, ${databaseOf(b.url)})`,
    );
    expect(restantes.map((r) => r.datname)).toEqual([databaseOf(b.url)]);
  }, 60_000);
});
