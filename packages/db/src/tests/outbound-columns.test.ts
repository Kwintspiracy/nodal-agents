// outbound-columns.test.ts — the columns of text that leave Nodal are read
// through the outbound seam: a real row, read raw and read for a browser; and
// every column of text of these tables is classified, so a column added
// tomorrow is in one list or the other before it reaches a page.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeSecret } from '@nodal-agents/test-kit';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { agentJobs, toolCalls } from '../schema/index.ts';
import {
  NOT_OUTBOUND_TEXT_COLUMNS,
  OUTBOUND_TEXT_COLUMNS,
  OUTBOUND_TEXT_TABLES,
  outboundColumn,
  outboundColumns,
  outboundSql,
  serverOnly,
} from '../outbound-columns.ts';

const KEY = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');

let db: TestDb;
let jobId: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  const seed = await seedMinimal(db);
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: `Deploy with ${KEY}`,
      result: `Done with ${KEY}`,
      error: null,
      messages: [{ role: 'user', content: `Deploy with ${KEY}` }],
      runnerNotes: [`note ${KEY}`],
    })
    .returning({ id: agentJobs.id });
  jobId = job!.id;
  await db.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId,
    toolName: 'run_command',
    toolInput: { command: `git push --token ${KEY}`, cwd: '/srv/app' },
    toolOutput: `ok ${KEY}`,
    durationMs: 1,
  });
});

describe('a column of agent text read for a browser is masked as it is read @cap:suivre-execution/moteur', () => {
  it('one column: text, JSON and an array of text, and a null stays null', async () => {
    const [row] = await db
      .select({
        task: outboundColumn(agentJobs.task),
        messages: outboundColumn(agentJobs.messages),
        runnerNotes: outboundColumn(agentJobs.runnerNotes),
        error: outboundColumn(agentJobs.error),
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row).toEqual({
      task: `Deploy with ${REDACTED_TEXT}`,
      messages: [{ role: 'user', content: `Deploy with ${REDACTED_TEXT}` }],
      runnerNotes: [`note ${REDACTED_TEXT}`],
      error: null,
    });
  });

  it('a whole row: its columns of text masked, every other column as the raw row has it', async () => {
    const [shown] = await db
      .select({ job: outboundColumns(agentJobs) })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    const [raw] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(Object.keys(shown!.job).sort()).toEqual(Object.keys(raw!).sort());
    expect(shown!.job.task).toBe(`Deploy with ${REDACTED_TEXT}`);
    expect(shown!.job.result).toBe(`Done with ${REDACTED_TEXT}`);
    expect(shown!.job.createdAt).toEqual(raw!.createdAt);
    expect(shown!.job.createdAt).toBeInstanceOf(Date);
    expect(shown!.job.status).toBe(raw!.status);
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });

  it('an aggregate over a column of text, and a tool call’s structured input', async () => {
    const [agg] = await db
      .select({
        first: outboundSql(sql<string | null>`(array_agg(${agentJobs.task}))[1]`),
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(agg!.first).toBe(`Deploy with ${REDACTED_TEXT}`);
    const [call] = await db
      .select({ toolInput: outboundColumn(toolCalls.toolInput) })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, jobId));
    expect(call!.toolInput).toEqual({
      command: `git push --token ${REDACTED_TEXT}`,
      cwd: '/srv/app',
    });
  });

  it('the row itself is untouched, and a server-only read stays raw', async () => {
    const [row] = await db
      .select({ task: serverOnly(agentJobs.task) })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row!.task).toBe(`Deploy with ${KEY}`);
  });
});

describe('every column of text of these tables is classified', () => {
  const TEXT_TYPES = new Set(['PgText', 'PgVarchar', 'PgChar', 'PgJson', 'PgJsonb', 'PgArray']);

  for (const [name, table] of Object.entries(OUTBOUND_TEXT_TABLES)) {
    it(`${name}: in the outbound list or in the other one, with its reason, never both`, () => {
      const columns = getTableColumns(table) as Record<string, { columnType: string }>;
      const textual = Object.entries(columns)
        .filter(([, c]) => TEXT_TYPES.has(c.columnType))
        .map(([k]) => k)
        .sort();
      const outbound = [
        ...(OUTBOUND_TEXT_COLUMNS[name as keyof typeof OUTBOUND_TEXT_COLUMNS] as readonly string[]),
      ];
      const other = Object.keys(
        NOT_OUTBOUND_TEXT_COLUMNS[name as keyof typeof NOT_OUTBOUND_TEXT_COLUMNS],
      );
      expect(outbound.filter((c) => other.includes(c))).toEqual([]);
      expect([...outbound, ...other].filter((c) => !(c in columns))).toEqual([]);
      expect([...outbound, ...other].sort()).toEqual(textual);
    });
  }
});
