// autonomy-rows-migration.pg.test.ts — migration 0155 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#917) : un agent tient UNE ligne d'autonomie par outil,
// et une ligne confinée à un dossier (« Approve for this project », #346) vit À
// CÔTÉ d'elle, pas à sa place :
//
//   - la ligne de l'outil et sa ligne de dossier coexistent pour le même agent ;
//   - deux lignes de l'outil, ou deux lignes du même dossier, restent refusées ;
//   - `condition_folder` est GÉNÉRÉ depuis `condition_json` : jamais écrit,
//     toujours vrai ;
//   - une règle « tous les agents » (agent_id nul) reste unique elle aussi ;
//   - `entities.autonomy_rows_written_at` existe, NULL sur un espace d'avant.
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

async function espace(db: Db, slug: string): Promise<string> {
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  );
  return e[0]!.id;
}

async function agent(db: Db, entityId: string, slug: string): Promise<string> {
  const a = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${entityId}, ${slug}, ${slug}, 'p') RETURNING id`,
  );
  return a[0]!.id;
}

async function ligne(
  db: Db,
  entityId: string,
  agentId: string | null,
  tool: string,
  action: string,
  condition: Record<string, unknown> = {},
): Promise<void> {
  await db.execute(
    sql`INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json)
        VALUES (${entityId}, ${agentId}, ${tool}, ${action}, ${JSON.stringify(condition)}::jsonb)`,
  );
}

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0155_autonomy_rows.sql', import.meta.url),
);

/** The constraint a refused insert names, read off the driver's error under drizzle's wrapper. */
async function refusedBy(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string; message?: string } }).cause;
    return cause?.constraint_name ?? cause?.message ?? String(err);
  }
  return 'not refused';
}

describe('migration 0155_autonomy_rows @cap:regler-autonomie/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a tool row and a folder row of the same agent coexist; duplicates of either are refused', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `rows-${Date.now()}`);
      const a = await agent(db, e, `agent-${Date.now()}`);

      await ligne(db, e, a, 'run_command', 'require_approval');
      await ligne(db, e, a, 'run_command', 'auto_approve', { workspacePath: 'D:/ws/dev' });
      await ligne(db, e, a, 'run_command', 'block', { workspacePath: 'D:/ws/prod' });

      const held = await rows<{ action: string; condition_folder: string }>(
        db,
        sql`SELECT action, condition_folder FROM approval_rules
            WHERE agent_id = ${a} AND tool_name = 'run_command' ORDER BY condition_folder`,
      );
      expect(held).toEqual([
        { action: 'require_approval', condition_folder: '' },
        { action: 'auto_approve', condition_folder: 'D:/ws/dev' },
        { action: 'block', condition_folder: 'D:/ws/prod' },
      ]);

      expect(await refusedBy(ligne(db, e, a, 'run_command', 'auto_approve'))).toBe(
        'approval_rules_entity_agent_tool_unique',
      );
      expect(
        await refusedBy(ligne(db, e, a, 'run_command', 'block', { workspacePath: 'D:/ws/dev' })),
      ).toBe('approval_rules_entity_agent_tool_unique');
    } finally {
      await close();
    }
  });

  it('a rule for every agent (agent_id NULL) stays unique, and an empty condition is no folder', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `everyone-${Date.now()}`);
      await ligne(db, e, null, 'srv__*', 'auto_approve');
      expect(await refusedBy(ligne(db, e, null, 'srv__*', 'block'))).toBe(
        'approval_rules_entity_agent_tool_unique',
      );
      await db.execute(
        sql`INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json)
            VALUES (${e}, NULL, 'file_read', 'block', NULL)`,
      );
      const [r] = await rows<{ condition_folder: string }>(
        db,
        sql`SELECT condition_folder FROM approval_rules WHERE entity_id = ${e} AND tool_name = 'file_read'`,
      );
      expect(r?.condition_folder).toBe('');
    } finally {
      await close();
    }
  });

  it('the generated folder follows condition_json, and cannot be written', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `generated-${Date.now()}`);
      const a = await agent(db, e, `gen-${Date.now()}`);
      await ligne(db, e, a, 'file_write', 'auto_approve', { workspacePath: 'D:/a' });
      await db.execute(
        sql`UPDATE approval_rules SET condition_json = '{"workspacePath":"D:/b"}'::jsonb
            WHERE agent_id = ${a} AND tool_name = 'file_write'`,
      );
      const [r] = await rows<{ condition_folder: string }>(
        db,
        sql`SELECT condition_folder FROM approval_rules WHERE agent_id = ${a} AND tool_name = 'file_write'`,
      );
      expect(r?.condition_folder).toBe('D:/b');
      await expect(
        db.execute(sql`UPDATE approval_rules SET condition_folder = 'x' WHERE agent_id = ${a}`),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('a workspace created after 0155 is born written: it has nothing from before to keep', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `before-${Date.now()}`);
      const [r] = await rows<{ autonomy_rows_written_at: Date | null }>(
        db,
        sql`SELECT autonomy_rows_written_at FROM entities WHERE id = ${e}`,
      );
      // Inserted after the migrations ran: the column's default applies. The
      // rows that existed when 0155 ran stayed NULL (ADD COLUMN, then the
      // default), which is what makes the first boot keep their screen.
      expect(r?.autonomy_rows_written_at).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('a workspace that existed when 0155 ran stays NULL: its first boot keeps what its screen showed', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // The column as it stood before 0155, then the migration's two
      // statements for it, replayed from the file itself.
      await db.execute(sql`ALTER TABLE entities DROP COLUMN autonomy_rows_written_at`);
      const before = await espace(db, `old-${Date.now()}`);
      const statements = readFileSync(MIGRATION, 'utf8')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.includes('autonomy_rows_written_at') && s.startsWith('ALTER'));
      expect(statements).toHaveLength(2);
      for (const st of statements) await db.execute(sql.raw(st));
      const after = await espace(db, `new-${Date.now()}`);

      const [old] = await rows<{ w: Date | null }>(
        db,
        sql`SELECT autonomy_rows_written_at AS w FROM entities WHERE id = ${before}`,
      );
      const [fresh] = await rows<{ w: Date | null }>(
        db,
        sql`SELECT autonomy_rows_written_at AS w FROM entities WHERE id = ${after}`,
      );
      expect(old?.w).toBeNull();
      expect(fresh?.w).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0155_autonomy_rows');
  });
});
