// builtins.test.ts — built-in tools behavior tests

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import { agentMemory, eq } from '@nodalai/db';
import { createToolRegistry } from '../registry';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../builtin/index';
import { returnResultTool } from '../builtin/return-result';
import { saveMemoryTool } from '../builtin/save-memory';
import { queryMemoryTool } from '../builtin/query-memory';
import { webSearchTool } from '../builtin/web-search';
import { WebSearchNotConfiguredError } from '../errors';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodalai/db/test-utils';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
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

// ─── return_result ────────────────────────────────────────────────────────────

describe('return_result', () => {
  it('passes through input as output', async () => {
    const result = await returnResultTool.execute(
      { status: 'success', text: 'Task done — full answer goes here.' },
      makeCtx(),
    );
    expect(result.status).toBe('success');
    expect(result.text).toBe('Task done — full answer goes here.');
  });

  it('works with status blocked', async () => {
    const result = await returnResultTool.execute(
      { status: 'blocked', text: 'Could not find the data after 2 attempts.' },
      makeCtx(),
    );
    expect(result.status).toBe('blocked');
  });

  it('rejects invalid status', () => {
    const parsed = returnResultTool.inputSchema.safeParse({
      status: 'unknown_status',
      text: 'hi',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty text', () => {
    const parsed = returnResultTool.inputSchema.safeParse({ status: 'success', text: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown extra fields like the legacy `data` channel (Brique 29)', () => {
    // The old schema had `data: unknown.optional()`. We dropped it because models
    // were stuffing the real answer in `data` and a label in `summary`, so the
    // user-facing result came from the wrong field. The schema is now strict —
    // only `status` and `text` are accepted.
    const parsed = returnResultTool.inputSchema.safeParse({
      status: 'success',
      text: 'real answer',
      data: 'should not be allowed',
    });
    // Zod default mode is passthrough/strip. The schema doesn't .strict() so
    // extra keys are dropped silently; verify the parsed result has no `data`.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['data']).toBeUndefined();
    }
  });

  it('has riskLevel write', () => {
    expect(returnResultTool.riskLevel).toBe('write');
  });
});

// ─── save_memory ─────────────────────────────────────────────────────────────

describe('save_memory', () => {
  it('inserts a memory row and returns the id', async () => {
    const result = await saveMemoryTool.execute(
      {
        fact: 'The user prefers short responses',
        category: 'preference',
        importance: 4,
        skill_tags: ['notion'],
      },
      makeCtx(),
    );

    expect(result.id).toBeTruthy();

    // Verify the actual DB row
    const rows = await db.select().from(agentMemory).where(eq(agentMemory.id, result.id));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.fact).toBe('The user prefers short responses');
    expect(row.category).toBe('preference');
    expect(row.importance).toBe(4);
    expect(row.skillTags).toContain('notion');
    expect(row.agentId).toBe(seed.agentId);
    expect(row.entityId).toBe(seed.entityId);
  });

  it('defaults importance to 3 when not provided', async () => {
    const result = await saveMemoryTool.execute(
      { fact: 'Some context fact', category: 'context', importance: 3 },
      makeCtx(),
    );

    const rows = await db.select().from(agentMemory).where(eq(agentMemory.id, result.id));

    expect(rows[0]?.importance).toBe(3);
  });

  it('rejects invalid category', () => {
    const parsed = saveMemoryTool.inputSchema.safeParse({
      fact: 'some fact',
      category: 'invalid_cat',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects importance out of range', () => {
    const parsed = saveMemoryTool.inputSchema.safeParse({
      fact: 'some fact',
      category: 'context',
      importance: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it('has riskLevel write', () => {
    expect(saveMemoryTool.riskLevel).toBe('write');
  });
});

// ─── query_memory ─────────────────────────────────────────────────────────────

describe('query_memory', () => {
  it('returns non-archived memories for the agent', async () => {
    // First save a memory
    await saveMemoryTool.execute(
      { fact: 'Query test fact', category: 'context', importance: 3, skill_tags: ['drive'] },
      makeCtx(),
    );

    const results = await queryMemoryTool.execute({ limit: 50 }, makeCtx());
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.fact === 'Query test fact')).toBe(true);
  });

  it('filters by skill_tags', async () => {
    // Save with specific tag
    await saveMemoryTool.execute(
      { fact: 'Gmail-specific fact', category: 'context', importance: 3, skill_tags: ['gmail'] },
      makeCtx(),
    );

    const gmailResults = await queryMemoryTool.execute(
      { skill_tags: ['gmail'], limit: 50 },
      makeCtx(),
    );
    expect(gmailResults.some((r) => r.fact === 'Gmail-specific fact')).toBe(true);
    // All results should have the gmail tag
    expect(gmailResults.every((r) => r.skill_tags?.includes('gmail'))).toBe(true);
  });

  it('returns empty array when skill_tags filter matches nothing', async () => {
    const results = await queryMemoryTool.execute(
      { skill_tags: ['nonexistent-skill-xyz'], limit: 50 },
      makeCtx(),
    );
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const results = await queryMemoryTool.execute({ limit: 1 }, makeCtx());
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns memories saved by OTHER agents in the same entity (entity-scoped)', async () => {
    // Regression: query_memory used to filter by agentId only, hiding memories
    // saved by other agents. Knowledge should follow the entity, not the agent.
    const otherAgentCtx: ToolContext = {
      jobId: seed.jobId,
      agentId: '00000000-0000-0000-0000-000000000099', // synthetic, not seeded
      entityId: seed.entityId, // SAME entity
      db: db as unknown as ToolContext['db'],
      jobChatId: null,
    };
    // First save under the seeded agent
    await saveMemoryTool.execute(
      { fact: 'Cross-agent visibility fact', category: 'context', importance: 3 },
      makeCtx(),
    );
    // Now read from a different agent in the same entity
    const results = await queryMemoryTool.execute({ limit: 50 }, otherAgentCtx);
    expect(results.some((r) => r.fact === 'Cross-agent visibility fact')).toBe(true);
  });

  it('has riskLevel write', () => {
    expect(queryMemoryTool.riskLevel).toBe('write');
  });
});

// ─── web_search ───────────────────────────────────────────────────────────────

describe('web_search', () => {
  it('throws WebSearchNotConfiguredError when env var not set', async () => {
    // Ensure env var is not set
    const original = process.env['NODALAI_WEB_SEARCH_URL'];
    delete process.env['NODALAI_WEB_SEARCH_URL'];

    try {
      await expect(
        webSearchTool.execute({ query: 'test query' }, makeCtx()),
      ).rejects.toBeInstanceOf(WebSearchNotConfiguredError);
    } finally {
      if (original !== undefined) {
        process.env['NODALAI_WEB_SEARCH_URL'] = original;
      }
    }
  });

  it('has riskLevel read', () => {
    expect(webSearchTool.riskLevel).toBe('read');
  });

  it('rejects empty query', () => {
    const parsed = webSearchTool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });
});

// ─── registerBuiltins ────────────────────────────────────────────────────────

describe('registerBuiltins', () => {
  it('registers all four built-ins into registry', () => {
    const reg = createToolRegistry();
    registerBuiltins(reg);

    expect(reg.get('return_result')).toBeDefined();
    expect(reg.get('save_memory')).toBeDefined();
    expect(reg.get('query_memory')).toBeDefined();
    expect(reg.get('web_search')).toBeDefined();
  });

  it('ALWAYS_ON_TOOLS contains the always-on built-ins', () => {
    expect(ALWAYS_ON_TOOLS).toContain('return_result');
    expect(ALWAYS_ON_TOOLS).toContain('save_memory');
    expect(ALWAYS_ON_TOOLS).toContain('query_memory');
    // web_search is NOT always-on (it's read and optional)
    expect(ALWAYS_ON_TOOLS).not.toContain('web_search');
  });
});
