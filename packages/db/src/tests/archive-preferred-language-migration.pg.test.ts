// archive-preferred-language-migration.pg.test.ts — migration 0162 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#986) :
//   - le souvenir que l'entretien d'accueil écrivait — souvenir d'espace,
//     saisi, préférence, « Operator — preferred language: … » — est ARCHIVÉ
//     (archived, valid_to posé) ; la ligne reste, lisible et réversible ;
//   - plusieurs lignes de ce genre dans un même espace : toutes archivées ;
//   - rien d'autre n'est touché : un préfixe voisin (« preferred languages »),
//     un autre préfixe de l'entretien, les mêmes mots au milieu d'une phrase,
//     un tiret différent, une minuscule, la même phrase écrite par un agent, ou
//     d'une autre source, ou d'une autre catégorie ;
//   - une ligne déjà archivée, ou déjà close (valid_to), n'est pas réécrite ;
//   - l'entrée du journal existe.
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

type Db = ReturnType<typeof createClient>['db'];

async function rows<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

async function newEntity(db: Db): Promise<string> {
  const tag = `lang-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${tag}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${tag}, ${tag}) RETURNING id`,
  );
  return e[0]!.id;
}

async function newAgent(db: Db, entityId: string): Promise<string> {
  const slug = `a-${Math.random().toString(36).slice(2, 8)}`;
  const r = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality) VALUES (${entityId}, ${slug}, ${slug}, 'p') RETURNING id`,
  );
  return r[0]!.id;
}

/** Une ligne telle que l'entretien l'écrivait, sauf ce que `opts` change. */
async function memory(
  db: Db,
  entityId: string,
  fact: string,
  opts: {
    agentId?: string;
    archived?: boolean;
    source?: string;
    category?: string;
    closed?: boolean;
  } = {},
): Promise<string> {
  const r = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agent_memory (entity_id, agent_id, fact, category, importance, source, archived, valid_to, updated_at)
        VALUES (${entityId}, ${opts.agentId ?? null}, ${fact}, ${opts.category ?? 'preference'}, 5,
                ${opts.source ?? 'manual'}, ${opts.archived ?? false},
                ${opts.closed ? '2026-01-01T00:00:00Z' : null}, '2026-01-01T00:00:00Z')
        RETURNING id`,
  );
  return r[0]!.id;
}

type State = { fact: string; archived: boolean; closed: boolean; touched: boolean };

async function stateOf(db: Db, id: string): Promise<State> {
  const r = await rows<State>(
    db,
    sql`SELECT fact, archived, valid_to IS NOT NULL AS closed,
               updated_at > '2026-01-01T00:00:00Z' AS touched
        FROM agent_memory WHERE id = ${id}`,
  );
  if (!r[0]) expect.fail(`memory ${id} is gone — the migration must never delete`);
  return r[0];
}

function migrationStatements(): string[] {
  const path = fileURLToPath(
    new URL('../../migrations/0162_archive_preferred_language.sql', import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0162_archive_preferred_language @cap:se-souvenir/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  // Mutations vérifiées : le UPDATE neutralisé → rouge (les lignes de
  // l'entretien restent actives) ; le préfixe comparé par
  // `LIKE 'Operator — preferred language%'` → rouge (« preferred languages »
  // est archivée) ; la condition `agent_id IS NULL` retirée → rouge (la copie
  // d'un agent est archivée).
  it('archives every row the interview wrote, and only those', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const ws = await newEntity(db);
      const agent = await newAgent(db, ws);
      const interview = [
        await memory(db, ws, 'Operator — preferred language: Francais'),
        await memory(db, ws, 'Operator — preferred language: 中文'),
      ];
      const untouched = [
        await memory(db, ws, 'Operator — preferred languages: French, English'),
        await memory(db, ws, 'Operator — what to call them: Quentin'),
        await memory(db, ws, 'Note: Operator — preferred language: French was asked at onboarding'),
        await memory(db, ws, 'Operator - preferred language: French'),
        await memory(db, ws, 'operator — preferred language: French'),
        await memory(db, ws, 'Operator — preferred language: French', {
          agentId: agent,
          source: 'agent',
        }),
        // Saisie à la main mais rattachée à un agent : pas une ligne de l'entretien.
        await memory(db, ws, 'Operator — preferred language: French', { agentId: agent }),
        await memory(db, ws, 'Operator — preferred language: French', { source: 'agent' }),
        await memory(db, ws, 'Operator — preferred language: French', { category: 'context' }),
      ];
      const alreadyArchived = await memory(db, ws, 'Operator — preferred language: English', {
        archived: true,
      });
      const alreadyClosed = await memory(db, ws, 'Operator — preferred language: Deutsch', {
        closed: true,
      });

      for (const statement of migrationStatements()) await db.execute(sql.raw(statement));

      expect(await stateOf(db, interview[0]!)).toEqual({
        fact: 'Operator — preferred language: Francais',
        archived: true,
        closed: true,
        touched: true,
      });
      expect(await stateOf(db, interview[1]!)).toMatchObject({ archived: true, closed: true });
      for (const id of untouched) {
        expect(await stateOf(db, id), `untouched ${id}`).toMatchObject({
          archived: false,
          closed: false,
          touched: false,
        });
      }
      expect(await stateOf(db, alreadyArchived)).toMatchObject({
        archived: true,
        closed: false,
        touched: false,
      });
      expect(await stateOf(db, alreadyClosed)).toMatchObject({
        archived: false,
        closed: true,
        touched: false,
      });
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0162_archive_preferred_language');
  });
});
