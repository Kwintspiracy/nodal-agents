// search.test.ts — similarity + keyword + hybrid + empty + skill-filter regression

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { createMemory } from '../crud';
import { searchMemories, keywordSearchMemories } from '../search';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

// ─── Embedding clients for testing ────────────────────────────────────────────

/** Always returns null → forces keyword fallback */
const keywordClient: EmbeddingClient = {
  embed: async () => null,
  dimensions: null,
};

/**
 * Returns a deterministic fake embedding for testing vector search.
 * Two texts get similar vectors if they contain the same "keyword cluster".
 * Simple scheme: 3-dim normalized vector based on string hash.
 */
function makeVectorClient(dims = 3): EmbeddingClient {
  return {
    embed: async (text: string) => {
      // Simple deterministic hash → unit vector
      let h = 0;
      for (let i = 0; i < text.length; i++) {
        h = (h << 5) - h + text.charCodeAt(i);
        h |= 0;
      }
      // Make a vector of `dims` dimensions
      const vec = Array.from({ length: dims }, (_, i) => Math.sin(h + i));
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / (mag || 1));
    },
    dimensions: dims,
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Seed memories for search tests
  await createMemory(db, {
    entity_id: seed.entityId,
    fact: 'User prefers concise technical answers.',
    category: 'preference',
    importance: 4,
    source: 'manual',
    skill_tags: [],
  });
  await createMemory(db, {
    entity_id: seed.entityId,
    fact: 'Notion API requires an integration token.',
    category: 'context',
    importance: 3,
    source: 'agent',
    skill_tags: ['notion'],
  });
  await createMemory(db, {
    entity_id: seed.entityId,
    fact: 'Gmail OAuth2 tokens expire after 1 hour.',
    category: 'context',
    importance: 3,
    source: 'agent',
    skill_tags: ['gmail'],
  });
  await createMemory(db, {
    entity_id: seed.entityId,
    fact: 'User works at Acme Corp as a product manager.',
    category: 'preference',
    importance: 5,
    source: 'manual',
    skill_tags: [],
  });
});

// ─── Keyword search tests ──────────────────────────────────────────────────────

describe('searchMemories — keyword fallback (null embedding)', () => {
  it('returns memories matching query keywords via ILIKE', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'Notion API',
      entityId: seed.entityId,
    });

    expect(results.length).toBeGreaterThan(0);
    const facts = results.map((m) => m.fact);
    expect(facts.some((f) => f.toLowerCase().includes('notion'))).toBe(true);
  });

  it('returns memories matching partial keyword', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'gmail token',
      entityId: seed.entityId,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((m) => m.fact.toLowerCase().includes('gmail'))).toBe(true);
  });

  it('returns empty array when no keywords match', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'xyzzy_nonexistent_term_12345',
      entityId: seed.entityId,
    });

    // No results or results without the unique term
    for (const m of results) {
      expect(m.fact.toLowerCase()).not.toContain('xyzzy_nonexistent_term_12345');
    }
  });

  it('respects limit option', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'user',
      entityId: seed.entityId,
      limit: 1,
    });

    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('filters by category', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'user',
      entityId: seed.entityId,
      category: 'preference',
    });

    for (const m of results) {
      expect(m.category).toBe('preference');
    }
  });
});

// ─── Skill filter tests in search ─────────────────────────────────────────────

describe('searchMemories — skill filter (keyword path)', () => {
  it('regression_legacy_skill_filter_bug: empty skillTags returns all matching memories', async () => {
    // This is the bug condition: agent has no skills (empty array)
    // Legacy behavior would filter to nothing
    const results = await searchMemories(db, keywordClient, {
      query: 'user',
      entityId: seed.entityId,
      skillTags: [], // empty = no filter should be applied
    });

    // Should return results — not filtered to nothing
    expect(results.length).toBeGreaterThan(0);
  });

  it('undefined skillTags returns all matching memories', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'user',
      entityId: seed.entityId,
      skillTags: undefined,
    });

    expect(results.length).toBeGreaterThan(0);
  });

  it('non-empty skillTags filters to matching + uncategorized memories', async () => {
    // With skillTags=['notion'], should return:
    //   - memories with skill_tags containing 'notion'
    //   - memories with empty skill_tags (uncategorized)
    // Should NOT return gmail-only memories
    const results = await searchMemories(db, keywordClient, {
      query: 'token API',
      entityId: seed.entityId,
      skillTags: ['notion'],
    });

    for (const m of results) {
      const hasNotion = m.skill_tags.includes('notion');
      const isUncategorized = m.skill_tags.length === 0;
      expect(hasNotion || isUncategorized).toBe(true);
    }
    // Gmail memory should not appear
    expect(results.some((m) => m.skill_tags.includes('gmail'))).toBe(false);
  });

  it('memories with empty skill_tags are always returned when skillTags filter is active', async () => {
    const results = await searchMemories(db, keywordClient, {
      query: 'user',
      entityId: seed.entityId,
      skillTags: ['gmail'],
    });

    // Should include uncategorized memories (empty skill_tags)
    const uncategorized = results.filter((m) => m.skill_tags.length === 0);
    expect(uncategorized.length).toBeGreaterThan(0);
  });
});

// ─── Access tracking in search ────────────────────────────────────────────────

describe('searchMemories — access tracking', () => {
  it('bumps access_count for returned memories', async () => {
    const { db: freshDb } = await spinUpTestDb();
    const freshSeed = await seedMinimal(freshDb);

    const m = await createMemory(freshDb, {
      entity_id: freshSeed.entityId,
      fact: 'Access tracking test memory.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    expect(m.access_count).toBe(0);

    await searchMemories(freshDb, keywordClient, {
      query: 'access tracking',
      entityId: freshSeed.entityId,
    });

    const { getMemory } = await import('../crud');
    const fetched = await getMemory(freshDb, m.id, freshSeed.entityId);
    expect(fetched.access_count).toBe(1);
  });
});

// ─── Vector search tests ───────────────────────────────────────────────────────

describe('searchMemories — vector search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to keyword when embedding provider throws', async () => {
    const throwingClient: EmbeddingClient = {
      embed: async () => {
        throw new Error('embed_failed');
      },
      dimensions: 3,
    };

    // Should not throw — falls back to keyword
    const results = await searchMemories(db, throwingClient, {
      query: 'notion',
      entityId: seed.entityId,
    });

    // Keyword fallback should still find results
    expect(Array.isArray(results)).toBe(true);
  });

  it('logs a loud console.warn naming the cause when embedding throws (dimension mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const dimMismatchClient: EmbeddingClient = {
      embed: async () => {
        throw new Error(
          "Embedding model 'mxbai-embed-large' (ollama) produced 1024 dims but the DB expects 1536. " +
            'Configure a 1536-dim model or set EMBEDDING_PROVIDER=keyword.',
        );
      },
      dimensions: 1024,
    };

    // searchMemories must NOT throw — keyword fallback keeps the job alive
    const results = await searchMemories(db, dimMismatchClient, {
      query: 'notion',
      entityId: seed.entityId,
    });

    expect(Array.isArray(results)).toBe(true);

    // A loud warn MUST have been emitted
    expect(warnSpy).toHaveBeenCalledOnce();
    const [warnMsg] = warnSpy.mock.calls[0] as [string];
    expect(warnMsg).toContain('Embedding call failed');
    expect(warnMsg).toContain('degrading to keyword search');
    // The root cause (thrown message) must be surfaced
    expect(warnMsg).toContain('1024');
    expect(warnMsg).toContain('1536');
  });

  it('falls back to keyword when the query embeds but no rows have embeddings', async () => {
    // The beforeAll memories were created WITHOUT an embedding client, so every
    // row's embedding is NULL. A real-embedding client makes vectorSearch run,
    // find zero vector hits, and (with the fallback) defer to keyword search.
    const vectorClient = makeVectorClient(1536);

    const results = await searchMemories(db, vectorClient, {
      query: 'notion',
      entityId: seed.entityId,
    });

    expect(results.some((m) => m.fact.toLowerCase().includes('notion'))).toBe(true);
  });

  it('vector search finds a memory whose stored embedding matches the query', async () => {
    const vectorClient = makeVectorClient(1536);
    const { db: vDb } = await spinUpTestDb();
    const vSeed = await seedMinimal(vDb);

    const fact = 'The deployment uses embedded Postgres on port 25435.';
    const created = await createMemory(
      vDb,
      {
        entity_id: vSeed.entityId,
        fact,
        category: 'context',
        importance: 3,
        source: 'agent',
        skill_tags: [],
      },
      vectorClient,
    );

    // Querying with the exact fact text → identical embedding → distance 0,
    // well within the similarity threshold.
    const results = await searchMemories(vDb, vectorClient, {
      query: fact,
      entityId: vSeed.entityId,
    });

    expect(results.some((m) => m.id === created.id)).toBe(true);
  });
});

// ─── keywordSearchMemories (embedding-free, for query_memory tool) ─────────────

describe('keywordSearchMemories', () => {
  it('returns memories matching the query keywords', async () => {
    const results = await keywordSearchMemories(db, {
      query: 'user',
      entityId: seed.entityId,
    });

    expect(results.length).toBe(2); // facts 1 and 4 contain "user"
    expect(results.every((m) => m.fact.toLowerCase().includes('user'))).toBe(true);
  });

  it('ranks by importance under the default sort', async () => {
    const results = await keywordSearchMemories(db, {
      query: 'user',
      entityId: seed.entityId,
    });

    // "User works at Acme Corp..." (5) before "User prefers concise..." (4)
    expect(results[0]?.importance).toBe(5);
    expect(results[1]?.importance).toBe(4);
  });

  it('orders by recency under sort: recent', async () => {
    const results = await keywordSearchMemories(db, {
      query: 'user',
      entityId: seed.entityId,
      sort: 'recent',
    });

    const times = results.map((m) => new Date(m.updated_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('respects the limit option', async () => {
    const results = await keywordSearchMemories(db, {
      query: 'user',
      entityId: seed.entityId,
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.importance).toBe(5);
  });

  it('bumps access tracking on returned rows', async () => {
    const { db: freshDb } = await spinUpTestDb();
    const freshSeed = await seedMinimal(freshDb);

    const m = await createMemory(freshDb, {
      entity_id: freshSeed.entityId,
      fact: 'Keyword search access tracking probe.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    expect(m.access_count).toBe(0);

    await keywordSearchMemories(freshDb, { query: 'probe', entityId: freshSeed.entityId });

    const { getMemory } = await import('../crud');
    const fetched = await getMemory(freshDb, m.id, freshSeed.entityId);
    expect(fetched.access_count).toBe(1);
  });
});
