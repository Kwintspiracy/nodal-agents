// query-memory.test.ts — query_memory tool: keyword search path + sort + regression
// Fixtures are created through the real save_memory tool (not direct inserts),
// so the test exercises the actual save → query pipeline.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { saveMemoryTool } from '../builtin/save-memory';
import { queryMemoryTool } from '../builtin/query-memory';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  const ctx = makeCtx();
  // Distinct facts (dedup is active) — three mention "typescript", one does not.
  await saveMemoryTool.execute(
    { fact: 'The user writes TypeScript in strict mode.', category: 'preference', importance: 5 },
    ctx,
  );
  await saveMemoryTool.execute(
    { fact: 'TypeScript config lives in tsconfig.base.json.', category: 'context', importance: 2 },
    ctx,
  );
  await saveMemoryTool.execute(
    { fact: 'The TypeScript build runs via Turborepo.', category: 'context', importance: 4 },
    ctx,
  );
  await saveMemoryTool.execute(
    { fact: 'The user enjoys hiking on weekends.', category: 'context', importance: 3 },
    ctx,
  );
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

describe('query_memory — keyword search path', () => {
  it('returns only memories matching the query', async () => {
    const results = await queryMemoryTool.execute({ query: 'typescript' }, makeCtx());

    expect(results.length).toBe(3);
    expect(results.every((r) => r.fact.toLowerCase().includes('typescript'))).toBe(true);
    expect(results.some((r) => r.fact.includes('hiking'))).toBe(false);
  });

  it('ranks results by importance (default sort)', async () => {
    const results = await queryMemoryTool.execute({ query: 'typescript' }, makeCtx());

    const importances = results.map((r) => r.importance ?? 0);
    // Descending importance: 5, 4, 2
    expect(importances).toEqual([...importances].sort((a, b) => b - a));
    expect(importances[0]).toBe(5);
  });

  it('respects the limit parameter on the search path', async () => {
    const results = await queryMemoryTool.execute({ query: 'typescript', limit: 1 }, makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0]?.importance).toBe(5);
  });

  it('returns an empty array when nothing matches the query', async () => {
    const results = await queryMemoryTool.execute({ query: 'kubernetes' }, makeCtx());
    expect(results).toEqual([]);
  });
});

describe('query_memory — list path (no query, regression)', () => {
  it('returns all non-archived memories when no query is given', async () => {
    const results = await queryMemoryTool.execute({}, makeCtx());
    expect(results.length).toBe(4);
  });

  it('orders the list path by importance by default', async () => {
    const results = await queryMemoryTool.execute({}, makeCtx());
    const importances = results.map((r) => r.importance ?? 0);
    expect(importances).toEqual([...importances].sort((a, b) => b - a));
  });

  it('still filters by skill_tags on the list path', async () => {
    const results = await queryMemoryTool.execute(
      { skill_tags: ['nonexistent-skill-xyz'] },
      makeCtx(),
    );
    expect(results).toEqual([]);
  });
});
