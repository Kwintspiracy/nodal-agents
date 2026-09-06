// code-projects-migration-0088.test.ts — T03 (plan « Vérifier & Corriger »).
//
// Applies the ACTUAL migration 0088 SQL to a bare pre-migration schema
// (users + entities + code_projects exactly as 0086 left them — no
// project_key, no verify_*, the old unnamed UNIQUE (entity_id, project_path)
// that Postgres auto-named `code_projects_entity_id_project_path_key`),
// seeded with realistic legacy duplicate-casing data, and asserts:
//   - the Windows-casing merge picks the most recently updated row and drops
//     the other;
//   - a POSIX casing pair (case-sensitive filesystem) does NOT merge;
//   - project_key computed by the migration's SQL matches projectKey() from
//     @nodal-agents/shared for a corpus covering backslashes, a trailing
//     slash, a UNC share, a drive letter, and a plain POSIX path;
//   - the old UNIQUE is gone and the new one is enforced;
//   - re-running just the backfill+merge block is a no-op (idempotency).
//
// Model: channel-migration-0064.test.ts (apply the real .sql split on
// drizzle's statement-breakpoint marker).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { projectKey } from '@nodal-agents/shared';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, '../../migrations/0088_code_projects_project_key.sql'),
  'utf8',
);

// Seven segments: ① ADD COLUMN, ② backfill UPDATE, ③ manifest-survival UPDATE
// (T20), ④ merge DELETE, ⑤ ALTER COLUMN SET NOT NULL, ⑥ ADD CONSTRAINT (new
// UNIQUE), ⑦ DO $$ … $$ (drop the old UNIQUE by its real pg_constraint name).
const statements = migrationSql
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
const addColumnsSql = statements[0]!;
const backfillSql = statements[1]!;
const manifestSql = statements[2]!;
const mergeSql = statements[3]!;

async function createPreMigrationDb(): Promise<{ pg: PGlite; entityId: string }> {
  const pg = new PGlite();
  // Exact 0086 shape (packages/db/migrations/0086_code_projects_rename_and_hide.sql):
  // unnamed UNIQUE (entity_id, project_path) — Postgres auto-names it
  // code_projects_entity_id_project_path_key, which is the name 0088's DO
  // block must find WITHOUT being told it in advance.
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE);
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, slug text NOT NULL UNIQUE
    );
    CREATE TABLE code_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      project_path text NOT NULL,
      display_name text,
      hidden boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (entity_id, project_path)
    );
  `);

  const { rows: users } = await pg.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`0088-migration-${Date.now()}-${Math.random()}@example.com`],
  );
  const { rows: entities } = await pg.query<{ id: string }>(
    `INSERT INTO entities (user_id, name, slug) VALUES ($1, '0088 Entity', $2) RETURNING id`,
    [users[0]!.id, `0088-entity-${Date.now()}-${Math.random()}`],
  );
  return { pg, entityId: entities[0]!.id };
}

async function applyFullMigration(pg: PGlite): Promise<void> {
  for (const stmt of statements) {
    await pg.exec(stmt);
  }
}

describe('migration 0088: code_projects project_key + verify_* + merge', () => {
  it('the migration splits into the seven expected statement-breakpoint segments', () => {
    expect(statements).toHaveLength(7);
  });

  it('merges a Windows-casing duplicate: the most recently updated row wins', async () => {
    const { pg, entityId } = await createPreMigrationDb();

    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    await pg.query(
      `INSERT INTO code_projects (entity_id, project_path, hidden, created_at, updated_at)
       VALUES ($1, 'D:/Legacy/App', true, $2, $2)`,
      [entityId, old],
    );
    const { rows: winnerRows } = await pg.query<{ id: string }>(
      `INSERT INTO code_projects (entity_id, project_path, display_name, hidden, created_at, updated_at)
       VALUES ($1, 'd:/legacy/app', 'Legacy', false, $2, $2) RETURNING id`,
      [entityId, recent],
    );
    const winnerId = winnerRows[0]!.id;

    await applyFullMigration(pg);

    const { rows } = await pg.query<{
      id: string;
      project_path: string;
      display_name: string | null;
      hidden: boolean;
    }>(`SELECT id, project_path, display_name, hidden FROM code_projects WHERE entity_id = $1`, [
      entityId,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winnerId);
    expect(rows[0]!.display_name).toBe('Legacy');
    expect(rows[0]!.project_path).toBe('d:/legacy/app');
    expect(rows[0]!.hidden).toBe(false);

    await pg.close();
  });

  it('does NOT merge a POSIX casing pair — /srv/App and /srv/app are two different projects', async () => {
    const { pg, entityId } = await createPreMigrationDb();

    await pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, '/srv/App')`, [
      entityId,
    ]);
    await pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, '/srv/app')`, [
      entityId,
    ]);

    await applyFullMigration(pg);

    const { rows } = await pg.query<{ project_path: string; project_key: string }>(
      `SELECT project_path, project_key FROM code_projects WHERE entity_id = $1 ORDER BY project_path`,
      [entityId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.project_key)).toEqual(['/srv/App', '/srv/app']);

    await pg.close();
  });

  it('project_key computed by the SQL backfill matches projectKey() from @nodal-agents/shared', async () => {
    const { pg, entityId } = await createPreMigrationDb();

    const corpus = [
      'C:\\Dev\\App\\', // backslashes + trailing slash
      '/srv/site/', // POSIX with trailing slash
      '\\\\serveur\\part\\App', // UNC share
      'D:/x/', // drive letter, trailing slash
      '/srv/plain', // plain POSIX, nothing to normalize
    ];
    for (const p of corpus) {
      await pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, $2)`, [
        entityId,
        p,
      ]);
    }

    await applyFullMigration(pg);

    const { rows } = await pg.query<{ project_path: string; project_key: string }>(
      `SELECT project_path, project_key FROM code_projects WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(corpus.length);
    for (const row of rows) {
      expect(row.project_key, `mismatch for "${row.project_path}"`).toBe(
        projectKey(row.project_path),
      );
    }

    await pg.close();
  });

  it('the old UNIQUE (entity_id, project_path) is gone; the new UNIQUE (entity_id, project_key) is enforced', async () => {
    const { pg, entityId } = await createPreMigrationDb();

    await pg.query(
      `INSERT INTO code_projects (entity_id, project_path) VALUES ($1, 'D:/Legacy/App')`,
      [entityId],
    );
    await applyFullMigration(pg);

    // Same key ('d:/legacy/app'), exact same text as an existing row's key —
    // rejected by the new UNIQUE.
    await expect(
      pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, 'd:/legacy/APP')`, [
        entityId,
      ]),
    ).rejects.toThrow();

    // Different TEXT, same key — the old (entity_id, project_path) unique
    // would have allowed this; the new one must not.
    await expect(
      pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, 'D:/Legacy/App')`, [
        entityId,
      ]),
    ).rejects.toThrow();

    const { rows: oldConstraintRows } = await pg.query(
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'code_projects' AND con.contype = 'u'
         AND (
           SELECT array_agg(a.attname ORDER BY a.attname)
           FROM unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         ) = ARRAY['entity_id','project_path']::name[]`,
    );
    expect(oldConstraintRows).toHaveLength(0);

    await pg.close();
  });

  it('re-running the backfill+merge block is a no-op (idempotency)', async () => {
    const { pg, entityId } = await createPreMigrationDb();

    await pg.query(
      `INSERT INTO code_projects (entity_id, project_path) VALUES ($1, 'D:/Legacy/App')`,
      [entityId],
    );
    await pg.query(`INSERT INTO code_projects (entity_id, project_path) VALUES ($1, '/srv/App')`, [
      entityId,
    ]);

    await applyFullMigration(pg);

    const { rows: before } = await pg.query<{ id: string; project_key: string }>(
      `SELECT id, project_key FROM code_projects WHERE entity_id = $1 ORDER BY id`,
      [entityId],
    );
    expect(before).toHaveLength(2);

    await expect(pg.exec(backfillSql)).resolves.toBeDefined();
    await expect(pg.exec(manifestSql)).resolves.toBeDefined();
    await expect(pg.exec(mergeSql)).resolves.toBeDefined();

    const { rows: after } = await pg.query<{ id: string; project_key: string }>(
      `SELECT id, project_key FROM code_projects WHERE entity_id = $1 ORDER BY id`,
      [entityId],
    );
    expect(after).toEqual(before);

    await pg.close();
  });
});

// ─── T20 — le manifeste survivant à la fusion ─────────────────────────────────
//
// Au premier passage la clause ne touche rien (les colonnes verify_* naissent
// dans 0088 — les tests ci-dessus le couvrent). Ces cas jouent la
// RÉ-EXÉCUTION : les colonnes existent déjà, des doublons portent des
// manifestes, et la règle du plan doit s'appliquer telle quelle.

interface VerifyRow {
  id: string;
  verify_commands: unknown;
  verify_approved_manifest_hash: string | null;
  verify_approved_at: string | null;
  verify_approved_by: string | null;
}

async function createReplayDb(): Promise<{ pg: PGlite; entityId: string; userId: string }> {
  const { pg, entityId } = await createPreMigrationDb();
  // Les colonnes existent déjà : c'est l'état d'une base où 0088 a déjà tourné.
  await pg.exec(addColumnsSql);
  const { rows } = await pg.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  return { pg, entityId, userId: rows[0]!.id };
}

async function replayFromBackfill(pg: PGlite): Promise<void> {
  for (const stmt of statements.slice(1)) await pg.exec(stmt);
}

const CMDS_AB = JSON.stringify([
  { command: 'pnpm typecheck', timeoutSeconds: 120 },
  { command: 'pnpm test', timeoutSeconds: 600 },
]);
// Même contenu, ordre des CLÉS d'objet différent : jsonb normalise, c'est identique.
const CMDS_AB_KEYS_REORDERED = JSON.stringify([
  { timeoutSeconds: 120, command: 'pnpm typecheck' },
  { timeoutSeconds: 600, command: 'pnpm test' },
]);
// Même contenu, ordre des COMMANDES différent : l'ordre appartient au manifeste.
const CMDS_BA = JSON.stringify([
  { command: 'pnpm test', timeoutSeconds: 600 },
  { command: 'pnpm typecheck', timeoutSeconds: 120 },
]);

async function insertDup(
  pg: PGlite,
  entityId: string,
  userId: string,
  path: string,
  commands: string,
  approvedAt: string | null,
  updatedAt: string,
  hash: string,
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO code_projects (entity_id, project_path, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
    [
      entityId,
      path,
      commands,
      approvedAt ? hash : null,
      approvedAt,
      approvedAt ? userId : null,
      updatedAt,
    ],
  );
  return rows[0]!.id;
}

const day = (n: number): string => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

describe('migration 0088 — T20 : le manifeste survivant à la fusion', () => {
  it('doublons divergents ⇒ pending_approval : une ligne, commandes du gagnant, approbation effacée', async () => {
    const { pg, entityId, userId } = await createReplayDb();
    // Perdante (ancienne) approuvée sur [A,B] ; gagnante (récente) approuvée sur [B,A].
    await insertDup(pg, entityId, userId, 'D:/Legacy/App', CMDS_AB, day(10), day(5), 'v1:old');
    const winner = await insertDup(
      pg,
      entityId,
      userId,
      'd:/legacy/app',
      CMDS_BA,
      day(2),
      day(1),
      'v1:new',
    );

    await replayFromBackfill(pg);

    const { rows } = await pg.query<VerifyRow>(
      `SELECT id, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by FROM code_projects WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winner);
    expect(rows[0]!.verify_commands).toEqual(JSON.parse(CMDS_BA));
    expect(rows[0]!.verify_approved_manifest_hash).toBeNull();
    expect(rows[0]!.verify_approved_at).toBeNull();
    expect(rows[0]!.verify_approved_by).toBeNull();
    await pg.close();
  });

  it('doublons identiques (clés JSON dans un autre ordre) ⇒ approbation reprise de la plus ANCIENNE', async () => {
    const { pg, entityId, userId } = await createReplayDb();
    const oldestApproval = day(30);
    await insertDup(
      pg,
      entityId,
      userId,
      'D:/Legacy/App',
      CMDS_AB,
      oldestApproval,
      day(20),
      'v1:origin',
    );
    const winner = await insertDup(
      pg,
      entityId,
      userId,
      'd:/legacy/app',
      CMDS_AB_KEYS_REORDERED,
      day(3),
      day(1),
      'v1:later',
    );

    await replayFromBackfill(pg);

    const { rows } = await pg.query<VerifyRow>(
      `SELECT id, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by FROM code_projects WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winner);
    expect(rows[0]!.verify_approved_manifest_hash).toBe('v1:origin');
    expect(new Date(rows[0]!.verify_approved_at!).toISOString()).toBe(oldestApproval);
    expect(rows[0]!.verify_approved_by).toBe(userId);
    await pg.close();
  });

  it('ordre des commandes différent ⇒ divergent, approbation effacée', async () => {
    const { pg, entityId, userId } = await createReplayDb();
    await insertDup(pg, entityId, userId, 'D:/Legacy/App', CMDS_AB, day(10), day(5), 'v1:ab');
    await insertDup(pg, entityId, userId, 'd:/legacy/app', CMDS_BA, day(9), day(1), 'v1:ba');

    await replayFromBackfill(pg);

    const { rows } = await pg.query<VerifyRow>(
      `SELECT id, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by FROM code_projects WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verify_approved_manifest_hash).toBeNull();
    await pg.close();
  });

  it('une ligne non approuvée dans le groupe ⇒ l’approbation ne survit pas (fail-closed)', async () => {
    const { pg, entityId, userId } = await createReplayDb();
    await insertDup(pg, entityId, userId, 'D:/Legacy/App', CMDS_AB, day(10), day(5), 'v1:ab');
    await insertDup(pg, entityId, userId, 'd:/legacy/app', CMDS_AB, null, day(1), 'unused');

    await replayFromBackfill(pg);

    const { rows } = await pg.query<VerifyRow>(
      `SELECT id, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by FROM code_projects WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verify_approved_manifest_hash).toBeNull();
    await pg.close();
  });

  it('idempotence : rejouer backfill + manifeste + fusion ⇒ zéro changement', async () => {
    const { pg, entityId, userId } = await createReplayDb();
    await insertDup(pg, entityId, userId, 'D:/Legacy/App', CMDS_AB, day(30), day(20), 'v1:origin');
    await insertDup(pg, entityId, userId, 'd:/legacy/app', CMDS_AB, day(3), day(1), 'v1:later');
    await replayFromBackfill(pg);

    const snapshot = async (): Promise<VerifyRow[]> =>
      (
        await pg.query<VerifyRow>(
          `SELECT id, verify_commands, verify_approved_manifest_hash, verify_approved_at, verify_approved_by FROM code_projects WHERE entity_id = $1 ORDER BY id`,
          [entityId],
        )
      ).rows;
    const before = await snapshot();
    expect(before).toHaveLength(1);
    expect(before[0]!.verify_approved_manifest_hash).toBe('v1:origin');

    await pg.exec(backfillSql);
    await pg.exec(manifestSql);
    await pg.exec(mergeSql);

    expect(await snapshot()).toEqual(before);
    await pg.close();
  });
});
