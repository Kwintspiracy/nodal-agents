// tool-call-writes.pg.test.ts — migration 0148 contre un VRAI Postgres.
//
// @cap:travailler-sur-des-fichiers/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration absente de
// `meta/_journal.json` est ignorée EN SILENCE par drizzle-kit pendant que toute
// la suite reste verte ; seul ce fichier, qui applique les VRAIES migrations,
// le voit.
//
// Ce qu'il prouve : `tool_call_writes` existe après les vraies migrations,
// liée à `tool_calls` ; une ligne se relit avec le `seq` de son appel ; les
// contraintes refusent un état hors des trois, et une empreinte qui ne va pas
// avec son état (un fichier « absent » ne porte pas d'empreinte, un fichier
// lu en porte une) ; supprimer l'appel supprime ses lignes.

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
  toolCallWrites,
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
const B = 'b'.repeat(64);

describe('migration 0148_tool_call_writes @cap:travailler-sur-des-fichiers/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('the table exists after the real migrations, with the columns the seam writes', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const cols = (await db.execute(
        sql`SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tool_call_writes'
            ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; is_nullable: string }>;
      expect(cols.map((c) => [c.column_name, c.is_nullable])).toEqual([
        ['after_kind', 'NO'],
        ['after_sha256', 'YES'],
        ['before_kind', 'NO'],
        ['before_sha256', 'YES'],
        ['created_at', 'NO'],
        ['id', 'NO'],
        ['job_id', 'NO'],
        ['path', 'NO'],
        ['tool_call_id', 'NO'],
      ]);
    } finally {
      await close();
    }
  });

  it('a row is read back with the seq of its call', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db.insert(users).values({ email: 'tcw@example.invalid' }).returning();
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'tcw', slug: 'tcw' })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, slug: 'tcw', name: 'tcw', personality: '' })
        .returning();
      const [job] = await db
        .insert(agentJobs)
        .values({ entityId: entity!.id, agentId: agent!.id, channel: 'api', task: '#779' })
        .returning();
      const [call] = await db
        .insert(toolCalls)
        .values({
          entityId: entity!.id,
          jobId: job!.id,
          toolName: 'file_write',
          riskLevel: 'write',
        })
        .returning();
      seme.jobId = job!.id;
      seme.callId = call!.id;
      await db.insert(toolCallWrites).values({
        toolCallId: call!.id,
        jobId: job!.id,
        path: 'C:/ws/shared/notes.txt',
        beforeKind: 'absent',
        beforeSha256: null,
        afterKind: 'file',
        afterSha256: A,
      });
      const rows = await db
        .select({
          seq: toolCalls.seq,
          tool: toolCalls.toolName,
          path: toolCallWrites.path,
          before: toolCallWrites.beforeKind,
          after: toolCallWrites.afterSha256,
        })
        .from(toolCallWrites)
        .innerJoin(toolCalls, eq(toolCalls.id, toolCallWrites.toolCallId));
      expect(rows).toEqual([
        {
          seq: call!.seq,
          tool: 'file_write',
          path: 'C:/ws/shared/notes.txt',
          before: 'absent',
          after: A,
        },
      ]);
    } finally {
      await close();
    }
  });

  it.each([
    [
      'a kind outside the three',
      { beforeKind: 'gone', beforeSha256: null, afterKind: 'file', afterSha256: A },
      'tool_call_writes_before_kind_check',
    ],
    [
      'an absent file with a hash',
      { beforeKind: 'absent', beforeSha256: B, afterKind: 'file', afterSha256: A },
      'tool_call_writes_before_sha_check',
    ],
    [
      'a read file without its hash',
      { beforeKind: 'file', beforeSha256: B, afterKind: 'file', afterSha256: null },
      'tool_call_writes_after_sha_check',
    ],
    [
      'an unreadable file with a hash',
      { beforeKind: 'file', beforeSha256: B, afterKind: 'unreadable', afterSha256: A },
      'tool_call_writes_after_sha_check',
    ],
  ])('refuses %s, by its named constraint', async (name, row, constraint) => {
    const { db, close } = createClient(harness().url, { max: 1 });
    let refus: unknown = null;
    try {
      await db.execute(
        sql`INSERT INTO tool_call_writes (tool_call_id, job_id, path, before_kind, before_sha256, after_kind, after_sha256)
            VALUES (${seme.callId}, ${seme.jobId}, ${`x-${name}`}, ${row.beforeKind}, ${row.beforeSha256}, ${row.afterKind}, ${row.afterSha256})`,
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
        .select({ id: toolCallWrites.id })
        .from(toolCallWrites)
        .where(eq(toolCallWrites.toolCallId, seme.callId));
      expect(left).toEqual([]);
    } finally {
      await close();
    }
  });
});
