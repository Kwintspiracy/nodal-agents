// agent-budget-migration.pg.test.ts — migration 0127 contre un VRAI Postgres.
//
// @cap:voir-le-cout/moteur
//
// CE QUE CELA PROUVE (#447) :
//   - les trois colonnes du budget de l'agent existent, 0 / 0 / 80 par défaut,
//     et leurs CHECK refusent ce qui ferait un budget absurde ;
//   - les colonnes et la table mortes sont parties ;
//   - LE REPLI ne change le comportement de personne : le plafond CLI devient
//     le plafond du jour SEULEMENT pour un agent qu'il bornait (runtime CLI,
//     ou outil code-task rattaché), jamais pour un agent ordinaire.
//
// Le repli se prouve en REJOUANT le fichier 0127 sur des lignes d'avant : la
// base est migrée jusqu'au bout, puis l'ancienne colonne est remise en place
// avec trois agents, et le fichier (idempotent) repasse.
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

async function agent(db: Db, entityId: string, slug: string, runtime = 'nodal'): Promise<string> {
  const a = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality, runtime)
        VALUES (${entityId}, ${slug}, ${slug}, 'p', ${runtime}) RETURNING id`,
  );
  return a[0]!.id;
}

describe('migration 0127_agent_budget @cap:voir-le-cout/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('the agent budget columns exist with neutral defaults, and the dead budget is gone', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `budget-cols-${Date.now()}`);
      const id = await agent(db, e, `plain-${Date.now()}`);
      const r = await rows<{ d: number; m: number; p: number }>(
        db,
        sql`SELECT budget_daily_usd AS d, budget_monthly_usd AS m, budget_alert_pct AS p FROM agents WHERE id = ${id}`,
      );
      expect(r[0]).toEqual({ d: 0, m: 0, p: 80 });

      const cols = await rows<{ c: string }>(
        db,
        sql`SELECT column_name AS c FROM information_schema.columns
            WHERE table_name = 'agents' AND column_name IN ('cli_daily_budget_usd', 'max_tokens_per_job')`,
      );
      expect(cols).toEqual([]);
      const tables = await rows<{ t: string }>(
        db,
        sql`SELECT table_name AS t FROM information_schema.tables WHERE table_name = 'agent_budgets'`,
      );
      expect(tables).toEqual([]);

      for (const bad of [
        sql`UPDATE agents SET budget_daily_usd = -1 WHERE id = ${id}`,
        sql`UPDATE agents SET budget_daily_usd = 1001 WHERE id = ${id}`,
        sql`UPDATE agents SET budget_monthly_usd = 10001 WHERE id = ${id}`,
        sql`UPDATE agents SET budget_alert_pct = 0 WHERE id = ${id}`,
        sql`UPDATE agents SET budget_alert_pct = 101 WHERE id = ${id}`,
      ]) {
        await expect(db.execute(bad)).rejects.toThrow();
      }
    } finally {
      await close();
    }
  });

  it('folds the CLI cap into the daily budget ONLY where it applied', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // The column as it was before 0127.
      await db.execute(
        sql`ALTER TABLE agents ADD COLUMN cli_daily_budget_usd real NOT NULL DEFAULT 10`,
      );
      const e = await espace(db, `budget-fold-${Date.now()}`);
      const cliRuntime = await agent(db, e, `cli-${Date.now()}`, 'claude-code');
      const withCodeTask = await agent(db, e, `ct-${Date.now()}`);
      const plain = await agent(db, e, `plain2-${Date.now()}`);
      await db.execute(sql`UPDATE agents SET cli_daily_budget_usd = 25 WHERE id = ${withCodeTask}`);
      const skill = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agent_skills (entity_id, slug, name, content)
            VALUES (${e}, 'code-task', 'Call a coding CLI', 'x') RETURNING id`,
      );
      await db.execute(
        sql`INSERT INTO agent_skill_assignments (entity_id, agent_id, skill_id)
            VALUES (${e}, ${withCodeTask}, ${skill[0]!.id})`,
      );

      const file = fileURLToPath(
        new URL('../../migrations/0127_agent_budget.sql', import.meta.url),
      );
      await db.execute(sql.raw(readFileSync(file, 'utf8')));

      const r = await rows<{ id: string; d: number }>(
        db,
        sql`SELECT id, budget_daily_usd AS d FROM agents WHERE id IN (${cliRuntime}, ${withCodeTask}, ${plain})`,
      );
      const byId = Object.fromEntries(r.map((x) => [x.id, x.d]));
      expect(byId[cliRuntime]).toBe(10);
      expect(byId[withCodeTask]).toBe(25);
      // An ordinary agent was never bounded by the CLI cap: it gets no ceiling.
      expect(byId[plain]).toBe(0);
      const cols = await rows<{ c: string }>(
        db,
        sql`SELECT column_name AS c FROM information_schema.columns
            WHERE table_name = 'agents' AND column_name = 'cli_daily_budget_usd'`,
      );
      expect(cols).toEqual([]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0127_agent_budget');
  });
});
