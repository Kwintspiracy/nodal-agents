// workspace-sandbox-gestures.pg.test.ts — deux gestes simultanés sur les
// dossiers permis d'un espace (#876) arrivent TOUS LES DEUX, sur un VRAI
// Postgres à plusieurs connexions, avec les VRAIES migrations (0153 comprise).
//
// PGlite n'a qu'une connexion : il ne peut pas montrer deux transactions qui
// se croisent. Ici, une connexion tient la ligne de l'espace pendant que deux
// gestes partent, chacun sur sa connexion ; elle ne la rend qu'une fois les
// deux en attente de verrou. Un geste qui lirait sans verrou aurait lu la
// valeur d'avant, et le second écrit effacerait le premier : un retrait perdu
// rouvre le dossier sans un mot.
//
// Mutation vérifiée : le `FOR UPDATE` retiré de `changeWorkspaceSandboxFolders`
// → les deux cas rougissent (un seul des deux gestes reste en base).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  entities,
  users,
  changeWorkspaceSandboxFolders,
  readWorkspaceSandbox,
} from '@nodal-agents/db';
import type { AnyDrizzleDb, SandboxFolderGesture } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;
let entityId = '';

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Les chemins de ce test sont des chaînes : la casse repliée, comme sous Windows. */
const folderKey = (p: string): string => p.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tient la ligne de l'espace, lance les gestes chacun sur sa connexion, et ne
 * rend la ligne qu'une fois tous en attente de verrou dans CETTE base.
 */
async function simultaneous(gestures: SandboxFolderGesture[]) {
  const holder = createClient(harness().url, { max: 1 });
  const clients = gestures.map(() => createClient(harness().url, { max: 1 }));
  try {
    let taken!: () => void;
    const lockTaken = new Promise<void>((r) => (taken = r));
    const hold = holder.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM entities WHERE id = ${entityId} FOR UPDATE`);
      taken();
      const deadline = Date.now() + 15_000;
      for (;;) {
        // Dans une transaction, pg_stat_activity est photographié au premier
        // accès : la photo est effacée à chaque tour pour relire l'état réel.
        await tx.execute(sql`SELECT pg_stat_clear_snapshot()`);
        const rows = (await tx.execute(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )) as unknown as Array<{ n: number }>;
        if (rows[0]!.n >= gestures.length) return;
        if (Date.now() > deadline) {
          throw new Error(`GESTURES_NOT_WAITING: ${rows[0]!.n}/${gestures.length} waiting`);
        }
        await sleep(25);
      }
    });
    await lockTaken;
    const outcomes = gestures.map((g, i) =>
      changeWorkspaceSandboxFolders(
        clients[i]!.db as unknown as AnyDrizzleDb,
        entityId,
        g,
        folderKey,
      ),
    );
    await hold;
    return await Promise.all(outcomes);
  } finally {
    await holder.close();
    for (const c of clients) await c.close();
  }
}

async function reset(folders: { added: string[]; removed: string[] }) {
  const { db, close } = createClient(harness().url, { max: 1 });
  try {
    await db.update(entities).set({ sandboxFolders: folders }).where(eq(entities.id, entityId));
  } finally {
    await close();
  }
}

async function stored() {
  const { db, close } = createClient(harness().url, { max: 1 });
  try {
    return (await readWorkspaceSandbox(db as unknown as AnyDrizzleDb, entityId)).folders;
  } finally {
    await close();
  }
}

describe('simultaneous gestures on the allowed folders all land @cap:executer-une-commande/moteur', () => {
  it('starts a real Postgres and applies the real migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    const { db, close } = createClient(pg.url, { max: 1 });
    try {
      const [user] = await db
        .insert(users)
        .values({ email: `sbx-gestures-${Date.now()}@example.com` })
        .returning({ id: users.id });
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'E', slug: `sbx-gestures-${Date.now()}` })
        .returning({ id: entities.id });
      entityId = entity!.id;
    } finally {
      await close();
    }
  }, 120_000);

  it('a removal and an addition at the same time: both are in the base, the removed folder stays removed', async () => {
    await reset({ added: [], removed: [] });
    const outcomes = await simultaneous([
      { op: 'remove', path: 'D:\\Models' },
      { op: 'add', path: 'E:\\lora', awaitsConfirmation: false },
    ]);
    expect(outcomes).toEqual(['removed', 'added']);
    expect(await stored()).toEqual({ added: ['E:\\lora'], removed: ['D:\\Models'] });
  });

  it('two additions, and a restoration with a removal, at the same time: nothing is lost', async () => {
    await reset({ added: [], removed: ['C:\\cache\\hf'] });
    const outcomes = await simultaneous([
      { op: 'add', path: 'E:\\a', awaitsConfirmation: false },
      { op: 'add', path: 'E:\\b', awaitsConfirmation: false },
      { op: 'restore', path: 'c:\\CACHE\\hf' },
      { op: 'remove', path: 'C:\\Users\\me\\.ollama\\models' },
    ]);
    expect(outcomes).toEqual(['added', 'added', 'restored', 'removed']);
    const after = await stored();
    expect([...after.added].sort()).toEqual(['E:\\a', 'E:\\b']);
    expect(after.removed).toEqual(['C:\\Users\\me\\.ollama\\models']);
  });
});
