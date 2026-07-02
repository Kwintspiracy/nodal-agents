// query-memory.test.ts — query_memory tool: keyword search path + sort + regression
// Fixtures are created through the real save_memory tool (not direct inserts),
// so the test exercises the actual save → query pipeline.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
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

// ─── query_memory — FTS robustness (ILIKE→FTS regression) ─────────────────────
// keywordSearchMemories builds an OR to_tsquery from the caller's free-text
// query. to_tsquery (unlike plainto_tsquery) THROWS on raw tsquery syntax
// (&, |, !, (, ), :) — the tool strips to plain alphanumerics before joining
// terms, so a query containing that syntax must never reach Postgres unsanitized.
describe('query_memory — FTS syntax robustness', () => {
  it('does not throw on a query containing raw tsquery operator syntax', async () => {
    await expect(
      queryMemoryTool.execute({ query: '"a" & b | c:* (nested)' }, makeCtx()),
    ).resolves.not.toThrow();
    const results = await queryMemoryTool.execute({ query: '"a" & b | c:* (nested)' }, makeCtx());
    expect(Array.isArray(results)).toBe(true);
  });

  it('an all-stopwords English query resolves gracefully (no invalid tsquery exception)', async () => {
    await expect(queryMemoryTool.execute({ query: 'the and of' }, makeCtx())).resolves.not.toThrow();
  });
});

// ─── query_memory — FTS ranking + access-tracking side effect ─────────────────
describe('query_memory — FTS ranking and access tracking', () => {
  it('ranks a fact matching MORE query terms above one matching fewer (ts_rank)', async () => {
    const ctx = makeCtx();
    const ts = Date.now();
    await saveMemoryTool.execute(
      {
        fact: `Deploy staging server nightly build ${ts}`,
        category: 'context',
        importance: 3,
      },
      ctx,
    );
    await saveMemoryTool.execute(
      {
        fact: `Deploy something unrelated entirely ${ts}`,
        category: 'context',
        importance: 3,
      },
      ctx,
    );

    const results = await queryMemoryTool.execute(
      { query: `deploy staging server nightly ${ts}` },
      ctx,
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The fact matching 4 query terms (deploy/staging/server/nightly) ranks
    // above the one matching only 1 (deploy) — even though both share the same
    // importance, so ranking is decided by ts_rank, not the importance tiebreak.
    expect(results[0]?.fact).toContain('staging server nightly');
  });

  it('bumps access_count on matched rows as a side effect of the search', async () => {
    const ctx = makeCtx();
    const ts = Date.now();
    await saveMemoryTool.execute(
      { fact: `Access-tracking probe fact ${ts}`, category: 'context', importance: 3 },
      ctx,
    );

    const before = await queryMemoryTool.execute({ query: `probe ${ts}` }, ctx);
    expect(before).toHaveLength(1);
    const matchedId = before[0]!.id;

    // Second search of the same fact should have bumped access_count to >=1
    // (touchMemories runs after the first search too, so it's already >=1;
    // assert it increases further on this second read).
    const [rowAfterFirst] = await db
      .select({ accessCount: agentMemory.accessCount })
      .from(agentMemory)
      .where(eq(agentMemory.id, matchedId));
    expect(rowAfterFirst?.accessCount ?? 0).toBeGreaterThanOrEqual(1);

    await queryMemoryTool.execute({ query: `probe ${ts}` }, ctx);
    const [rowAfterSecond] = await db
      .select({ accessCount: agentMemory.accessCount })
      .from(agentMemory)
      .where(eq(agentMemory.id, matchedId));
    expect(rowAfterSecond?.accessCount ?? 0).toBeGreaterThan(rowAfterFirst?.accessCount ?? 0);
  });
});
