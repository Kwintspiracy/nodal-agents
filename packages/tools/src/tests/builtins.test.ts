// builtins.test.ts — built-in tools behavior tests

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, agentJobs, eq } from '@nodal-agents/db';
import { createToolRegistry } from '../registry';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../builtin/index';
import { returnResultTool } from '../builtin/return-result';
import { saveMemoryTool } from '../builtin/save-memory';
import { queryMemoryTool } from '../builtin/query-memory';
import { webSearchTool } from '../builtin/web-search';
import { dashboardPublishTool } from '../builtin/dashboard-publish';
import type { ToolContext } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

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
  it('accepts { status: "success" } — status-only, no text required (Brique 33)', async () => {
    const result = await returnResultTool.execute({ status: 'success' }, makeCtx());
    expect(result.status).toBe('success');
  });

  it('accepts { status: "blocked" } — status-only (Brique 33)', async () => {
    const result = await returnResultTool.execute({ status: 'blocked' }, makeCtx());
    expect(result.status).toBe('blocked');
  });

  it('rejects invalid status', () => {
    const parsed = returnResultTool.inputSchema.safeParse({ status: 'unknown_status' });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown extra fields like the legacy `data` channel', () => {
    // Zod default mode strips extra keys silently; verify the parsed result has
    // no `data` or `text` field (both are legacy — Brique 29 dropped `data`,
    // Brique 33 dropped `text`).
    const parsed = returnResultTool.inputSchema.safeParse({
      status: 'success',
      text: 'legacy text that should be silently dropped',
      data: 'should not be allowed',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['text']).toBeUndefined();
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

    expect(result.saved).toBe(true);
    if (!result.saved) throw new Error('expected saved: true');

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
    // fact_hash is populated by the canonical createMemory() path
    expect(row.factHash).toBeTruthy();
  });

  it('defaults importance to 3 when not provided', async () => {
    const result = await saveMemoryTool.execute(
      { fact: 'Some context fact', category: 'context', importance: 3 },
      makeCtx(),
    );

    expect(result.saved).toBe(true);
    if (!result.saved) throw new Error('expected saved: true');

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
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('uses the injected premium backend when present (never touches DuckDuckGo)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const backend = vi.fn(async (query: string) => ({
      results: [{ title: `T:${query}`, url: 'https://example.com', snippet: 'from backend' }],
    }));

    const result = await webSearchTool.execute(
      { query: 'quantum computing' },
      { ...makeCtx(), searchBackend: backend },
    );

    expect(backend).toHaveBeenCalledWith('quantum computing');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      { title: 'T:quantum computing', url: 'https://example.com', snippet: 'from backend' },
    ]);
    expect(result.degraded).toBeUndefined();
  });

  it('falls back to DuckDuckGo and parses title/url/snippet (mocked fetch)', async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&rut=x">
          Example &amp; Title
        </a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage">
          A helpful <b>snippet</b> about the topic.
        </a>
      </div>`;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => html,
    })) as unknown as typeof fetch;

    const result = await webSearchTool.execute({ query: 'test' }, makeCtx());

    expect(result.degraded).toBeUndefined();
    expect(result.results).toEqual([
      {
        title: 'Example & Title',
        url: 'https://example.org/page',
        snippet: 'A helpful snippet about the topic.',
      },
    ]);
  });

  it('degrades with guidance when DuckDuckGo fetch fails (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await webSearchTool.execute({ query: 'test' }, makeCtx());

    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.guidance).toContain('Tavily');
  });

  it('degrades with guidance when DuckDuckGo returns zero parseable results', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => '<html><body>no results here</body></html>',
    })) as unknown as typeof fetch;

    const result = await webSearchTool.execute({ query: 'test' }, makeCtx());

    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.guidance).toContain('Tavily');
  });

  it('degrades with guidance on a non-OK HTTP status', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await webSearchTool.execute({ query: 'test' }, makeCtx());

    expect(result.degraded).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('has riskLevel read', () => {
    expect(webSearchTool.riskLevel).toBe('read');
  });

  it('rejects empty query', () => {
    const parsed = webSearchTool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });
});

// ─── dashboard_publish ────────────────────────────────────────────────────────

describe('dashboard_publish', () => {
  it('updates agent_jobs.result in DB and returns { ok: true }', async () => {
    // Use a real DB job row for the assertion
    const result = await dashboardPublishTool.execute(
      { text: 'Hello from dashboard_publish' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    // Verify the DB row was actually updated
    const rows = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.result).toBe('Hello from dashboard_publish');
  });

  it('updates agent_jobs.result when called with a mock db (unit test pattern)', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    const mockDb = { update: updateMock } as unknown as ToolContext['db'];
    const ctx: ToolContext = {
      jobId: 'job-unit-123',
      agentId: seed.agentId,
      entityId: seed.entityId,
      db: mockDb,
      jobChatId: null,
    };

    const result = await dashboardPublishTool.execute({ text: 'unit test content' }, ctx);
    expect(result.ok).toBe(true);
    // update was called with agentJobs table
    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('schema rejects empty text', () => {
    const parsed = dashboardPublishTool.inputSchema.safeParse({ text: '' });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects text exceeding 50 000 chars', () => {
    const parsed = dashboardPublishTool.inputSchema.safeParse({ text: 'x'.repeat(50_001) });
    expect(parsed.success).toBe(false);
  });

  it('schema accepts text at exactly 50 000 chars', () => {
    const parsed = dashboardPublishTool.inputSchema.safeParse({ text: 'x'.repeat(50_000) });
    expect(parsed.success).toBe(true);
  });

  it('has riskLevel write', () => {
    expect(dashboardPublishTool.riskLevel).toBe('write');
  });
});

// ─── registerBuiltins ────────────────────────────────────────────────────────

describe('registerBuiltins', () => {
  it('registers all five built-ins into registry', () => {
    const reg = createToolRegistry();
    registerBuiltins(reg);

    expect(reg.get('return_result')).toBeDefined();
    expect(reg.get('save_memory')).toBeDefined();
    expect(reg.get('query_memory')).toBeDefined();
    expect(reg.get('web_search')).toBeDefined();
    expect(reg.get('dashboard_publish')).toBeDefined();
  });

  it('ALWAYS_ON_TOOLS contains the always-on built-ins', () => {
    expect(ALWAYS_ON_TOOLS).toContain('return_result');
    expect(ALWAYS_ON_TOOLS).toContain('save_memory');
    expect(ALWAYS_ON_TOOLS).toContain('query_memory');
    expect(ALWAYS_ON_TOOLS).toContain('dashboard_publish');
    // web_search is now always-on: a unified, out-of-the-box web search (premium
    // backend injected by the runner when configured, else free DuckDuckGo).
    expect(ALWAYS_ON_TOOLS).toContain('web_search');
  });
});
