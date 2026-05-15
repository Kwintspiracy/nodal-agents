// mark-memory.test.ts — mark_memory_helpful + mark_memory_outdated
// Sprint 2 feedback loop: agent can express preferences over the memory pool
// via substring matching (no IDs surfaced in the system-prompt block).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import { markMemoryHelpfulTool } from '../builtin/mark-memory-helpful';
import { markMemoryOutdatedTool } from '../builtin/mark-memory-outdated';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentMemory);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function seedMemory(fact: string, importance = 3) {
  const [row] = await db
    .insert(agentMemory)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      fact,
      category: 'context',
      importance,
      source: 'agent',
    })
    .returning();
  return row!;
}

// ─── mark_memory_helpful ─────────────────────────────────────────────────────

describe('mark_memory_helpful', () => {
  it('bumps importance by 1 when a unique substring matches', async () => {
    const seeded = await seedMemory('user prefers TypeScript strict mode', 3);
    const result = await markMemoryHelpfulTool.execute(
      { fact_substring: 'TypeScript strict' },
      makeCtx(),
    );
    expect(result).toMatchObject({ marked: true, newImportance: 4 });
    const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, seeded.id));
    expect(row?.importance).toBe(4);
  });

  it('caps importance at 5 — no-op when already at the ceiling', async () => {
    const seeded = await seedMemory('user is the founder', 5);
    const result = await markMemoryHelpfulTool.execute(
      { fact_substring: 'founder' },
      makeCtx(),
    );
    expect(result).toMatchObject({ marked: true, newImportance: 5 });
    const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, seeded.id));
    expect(row?.importance).toBe(5);
  });

  it('returns { marked: false } with explicit reason on zero matches', async () => {
    await seedMemory('unrelated fact');
    const result = await markMemoryHelpfulTool.execute(
      { fact_substring: 'does-not-exist' },
      makeCtx(),
    );
    expect(result.marked).toBe(false);
    if (result.marked) throw new Error('expected marked: false');
    expect(result.reason).toContain('No memory matches');
  });

  it('returns { marked: false } with ambiguous-match reason when 2+ rows match', async () => {
    await seedMemory('user works in Paris');
    await seedMemory('user used to live in Paris');
    const result = await markMemoryHelpfulTool.execute(
      { fact_substring: 'Paris' },
      makeCtx(),
    );
    expect(result.marked).toBe(false);
    if (result.marked) throw new Error('expected marked: false');
    expect(result.reason).toContain('Ambiguous');
  });
});

// ─── mark_memory_outdated ────────────────────────────────────────────────────

describe('mark_memory_outdated', () => {
  it('archives the memory and sets valid_to when a unique substring matches', async () => {
    const seeded = await seedMemory('user lives in Paris', 4);
    const before = Date.now();
    const result = await markMemoryOutdatedTool.execute(
      { fact_substring: 'lives in Paris', reason: 'moved to Lyon last week' },
      makeCtx(),
    );
    expect(result).toMatchObject({ archived: true, id: seeded.id });
    const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, seeded.id));
    expect(row?.archived).toBe(true);
    expect(row?.validTo).toBeTruthy();
    expect(row?.validTo!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns { archived: false } with explicit reason on zero matches', async () => {
    await seedMemory('user lives in Paris');
    const result = await markMemoryOutdatedTool.execute(
      { fact_substring: 'New York' },
      makeCtx(),
    );
    expect(result.archived).toBe(false);
    if (result.archived) throw new Error('expected archived: false');
    expect(result.reason).toContain('No memory matches');
  });

  it('returns { archived: false } on ambiguous matches without archiving any row', async () => {
    const a = await seedMemory('Paris office is at rue X');
    const b = await seedMemory('Paris stand-up is at 10am');
    const result = await markMemoryOutdatedTool.execute(
      { fact_substring: 'Paris' },
      makeCtx(),
    );
    expect(result.archived).toBe(false);
    const [ra] = await db.select().from(agentMemory).where(eq(agentMemory.id, a.id));
    const [rb] = await db.select().from(agentMemory).where(eq(agentMemory.id, b.id));
    expect(ra?.archived).toBe(false);
    expect(rb?.archived).toBe(false);
  });

  it('cannot find an already-archived memory (excluded from search)', async () => {
    const seeded = await seedMemory('user lives in Paris', 3);
    await db.update(agentMemory).set({ archived: true }).where(eq(agentMemory.id, seeded.id));
    const result = await markMemoryOutdatedTool.execute(
      { fact_substring: 'Paris' },
      makeCtx(),
    );
    expect(result.archived).toBe(false);
  });
});
