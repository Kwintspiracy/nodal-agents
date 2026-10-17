// tool-call-reads.pg.test.ts — migration 0149 contre un VRAI Postgres.
//
// @cap:travailler-sur-des-fichiers/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration absente de
// `meta/_journal.json` est ignorée EN SILENCE par drizzle-kit pendant que toute
// la suite reste verte ; seul ce fichier, qui applique les VRAIES migrations,
// le voit.
//
// Ce qu'il prouve : `tool_call_reads` existe après les vraies migrations, liée
// à `tool_calls` ; une ligne se relit avec le `seq` de son appel ; les
// contraintes refusent une empreinte qui n'en est pas une, et un même fichier
// rangé deux fois pour le même appel ; supprimer l'appel supprime ses lignes.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  agentJobs,
  agents,
  entities,
  toolCalls,
  toolCallReads,
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

const seme = { jobId: '', callId: '' };
const A = 'a'.repeat(64);

describe('migration 0149_tool_call_reads @cap:travailler-sur-des-fichiers/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('the table exists after the real migrations, with the columns the seam writes', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const cols = (await db.execute(
        sql`SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tool_call_reads'
            ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; is_nullable: string }>;
      expect(cols.map((c) => [c.column_name, c.is_nullable])).toEqual([
        ['created_at', 'NO'],
        ['id', 'NO'],
        ['job_id', 'NO'],
        ['path', 'NO'],
        ['sha256', 'NO'],
        ['tool_call_id', 'NO'],
      ]);
    } finally {
      await close();
    }
  });

  it('a row is read back with the tool and the seq of its call', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db.insert(users).values({ email: 'tcr@example.invalid' }).returning();
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'tcr', slug: 'tcr' })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, slug: 'tcr', name: 'tcr', personality: '' })
        .returning();
      const [job] = await db
        .insert(agentJobs)
        .values({ entityId: entity!.id, agentId: agent!.id, channel: 'api', task: 'reads' })
        .returning();
      const [call] = await db
        .insert(toolCalls)
        .values({
          entityId: entity!.id,
          jobId: job!.id,
          toolName: 'file_read',
          riskLevel: 'read',
        })
        .returning();
      seme.jobId = job!.id;
      seme.callId = call!.id;
      await db.insert(toolCallReads).values({
        toolCallId: call!.id,
        jobId: job!.id,
        path: 'C:/ws/shared/notes.txt',
        sha256: A,
      });
      const rows = await db
        .select({
          seq: toolCalls.seq,
          tool: toolCalls.toolName,
          path: toolCallReads.path,
          sha256: toolCallReads.sha256,
        })
        .from(toolCallReads)
        .innerJoin(toolCalls, eq(toolCalls.id, toolCallReads.toolCallId));
      expect(rows).toEqual([
        { seq: call!.seq, tool: 'file_read', path: 'C:/ws/shared/notes.txt', sha256: A },
      ]);
    } finally {
      await close();
    }
  });

  it.each([
    [
      'a hash that is not a sha-256',
      'C:/ws/shared/autre.txt',
      'abc',
      'tool_call_reads_sha256_check',
    ],
    [
      'an upper-case hash',
      'C:/ws/shared/autre.txt',
      'A'.repeat(64),
      'tool_call_reads_sha256_check',
    ],
    [
      'the same file twice on the same call',
      'C:/ws/shared/notes.txt',
      A,
      'tool_call_reads_call_path_unique',
    ],
  ])('refuses %s, by its named constraint', async (_name, path, sha256, constraint) => {
    const { db, close } = createClient(harness().url, { max: 1 });
    let refus: unknown = null;
    try {
      await db.execute(
        sql`INSERT INTO tool_call_reads (tool_call_id, job_id, path, sha256)
            VALUES (${seme.callId}, ${seme.jobId}, ${path}, ${sha256})`,
      );
    } catch (err) {
      refus = err;
    } finally {
      await close();
    }
    // La contrainte NOMMÉE, pas un refus quelconque : le pilote range le détail dans `cause`.
    const noms: string[] = [];
    for (let e: unknown = refus; e !== null && e !== undefined; ) {
      const o = e as { message?: unknown; constraint_name?: unknown; cause?: unknown };
      if (typeof o.message === 'string') noms.push(o.message);
      if (typeof o.constraint_name === 'string') noms.push(o.constraint_name);
      e = o.cause ?? null;
    }
    expect(noms.join(' | ')).toContain(constraint);
  });

  it('deleting the call deletes its rows (on delete cascade)', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.delete(toolCalls).where(eq(toolCalls.id, seme.callId));
      const left = await db
        .select({ id: toolCallReads.id })
        .from(toolCallReads)
        .where(eq(toolCallReads.toolCallId, seme.callId));
      expect(left).toEqual([]);
    } finally {
      await close();
    }
  });
});
