// filter.test.ts — applySkillFilter + filterByTags

import { describe, it, expect } from 'vitest';
import { applySkillFilter, filterByTags } from '../filter.js';
import type { AgentMemory } from '@nodalai/shared';

// ─── Test fixtures ─────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id: crypto.randomUUID(),
    entity_id: 'entity-1',
    agent_id: null,
    fact: 'test fact',
    category: 'context',
    importance: 3,
    source: 'agent',
    skill_tags: [],
    memory_layer: null,
    valid_from: null,
    valid_to: null,
    fact_hash: null,
    archived: false,
    last_accessed_at: null,
    access_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const getMemoryTags = (m: AgentMemory) => m.skill_tags ?? [];

// ─── applySkillFilter — regression test (THE critical bug fix) ─────────────────

describe('applySkillFilter — regression_legacy_skill_filter_bug', () => {
  /**
   * THE REGRESSION: In legacy KwintAgents memory.py, ALL memories (including
   * agent-scoped ones) were filtered by skill_tags overlap. An agent with NO
   * declared skills (empty agentSkillTags) would result in an empty overlap →
   * ALL memories filtered out. The agent saw nothing.
   *
   * Fixed behavior: when agentSkillTags is undefined OR empty → return ALL
   * memories, no filter applied.
   */
  it('regression_legacy_skill_filter_bug: agent with NO skills declared sees all memories', () => {
    const memories = [
      makeMemory({ fact: 'memory A', skill_tags: ['gmail'] }),
      makeMemory({ fact: 'memory B', skill_tags: ['notion'] }),
      makeMemory({ fact: 'memory C', skill_tags: [] }),
    ];

    // Bug condition: agent has NO skills (empty array — as loaded from DB)
    const agentSkillTags: string[] = [];

    const result = applySkillFilter(memories, agentSkillTags, getMemoryTags);

    // Should return ALL memories — not empty
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.fact)).toContain('memory A');
    expect(result.map((m) => m.fact)).toContain('memory B');
    expect(result.map((m) => m.fact)).toContain('memory C');
  });

  it('regression_legacy_skill_filter_bug: agent with undefined skills sees all memories', () => {
    const memories = [
      makeMemory({ fact: 'memory X', skill_tags: ['drive'] }),
      makeMemory({ fact: 'memory Y', skill_tags: [] }),
    ];

    // Bug condition: agentSkillTags is undefined (not loaded / not assigned)
    const result = applySkillFilter(memories, undefined, getMemoryTags);

    expect(result).toHaveLength(2);
  });
});

// ─── applySkillFilter — correct filtering semantics ───────────────────────────

describe('applySkillFilter — intersection semantics', () => {
  it('returns only memories with overlapping tags when agent has skills', () => {
    const memories = [
      makeMemory({ fact: 'gmail memory', skill_tags: ['gmail'] }),
      makeMemory({ fact: 'notion memory', skill_tags: ['notion'] }),
      makeMemory({ fact: 'shared memory', skill_tags: ['gmail', 'notion'] }),
      makeMemory({ fact: 'drive memory', skill_tags: ['drive'] }),
    ];

    const result = applySkillFilter(memories, ['gmail'], getMemoryTags);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.fact)).toContain('gmail memory');
    expect(result.map((m) => m.fact)).toContain('shared memory');
    expect(result.map((m) => m.fact)).not.toContain('notion memory');
    expect(result.map((m) => m.fact)).not.toContain('drive memory');
  });

  it('always returns memories with empty skill_tags (uncategorized = general purpose)', () => {
    const memories = [
      makeMemory({ fact: 'uncategorized', skill_tags: [] }),
      makeMemory({ fact: 'gmail only', skill_tags: ['gmail'] }),
      makeMemory({ fact: 'notion only', skill_tags: ['notion'] }),
    ];

    // Agent only has gmail skills
    const result = applySkillFilter(memories, ['gmail'], getMemoryTags);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.fact)).toContain('uncategorized');
    expect(result.map((m) => m.fact)).toContain('gmail only');
    // notion memory excluded
    expect(result.map((m) => m.fact)).not.toContain('notion only');
  });

  it('returns empty array when no memories match non-empty skill filter', () => {
    const memories = [
      makeMemory({ skill_tags: ['notion'] }),
      makeMemory({ skill_tags: ['drive'] }),
    ];

    const result = applySkillFilter(memories, ['gmail'], getMemoryTags);

    // No uncategorized memories → only memories with matching tags pass
    expect(result).toHaveLength(0);
  });

  it('handles memories with null skill_tags gracefully', () => {
    const memories = [
      // Simulate a DB row where skill_tags is null (shouldn't happen but defensive)
      makeMemory({ fact: 'null tags', skill_tags: null as unknown as string[] }),
      makeMemory({ fact: 'empty tags', skill_tags: [] }),
    ];

    // getMemoryTags returns [] when skill_tags is null
    const safeGet = (m: AgentMemory) => m.skill_tags ?? [];
    const result = applySkillFilter(memories, ['gmail'], safeGet);

    // Both null and empty tags are treated as uncategorized → always returned
    expect(result).toHaveLength(2);
  });
});

// ─── filterByTags — OR semantics ──────────────────────────────────────────────

describe('filterByTags', () => {
  it('returns all memories when filterTags is empty', () => {
    const memories = [
      makeMemory({ skill_tags: ['gmail'] }),
      makeMemory({ skill_tags: ['notion'] }),
    ];

    expect(filterByTags(memories, [], getMemoryTags)).toHaveLength(2);
  });

  it('returns memories matching any tag in filterTags (OR semantics)', () => {
    const memories = [
      makeMemory({ fact: 'gmail', skill_tags: ['gmail'] }),
      makeMemory({ fact: 'notion', skill_tags: ['notion'] }),
      makeMemory({ fact: 'drive', skill_tags: ['drive'] }),
      makeMemory({ fact: 'multi', skill_tags: ['gmail', 'drive'] }),
    ];

    const result = filterByTags(memories, ['gmail', 'notion'], getMemoryTags);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.fact)).not.toContain('drive');
  });

  it('returns empty array when no memories match', () => {
    const memories = [makeMemory({ skill_tags: ['notion'] })];
    expect(filterByTags(memories, ['gmail'], getMemoryTags)).toHaveLength(0);
  });
});
