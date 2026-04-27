// router/only-one-per-turn.test.ts — filterToolCallsForDelegation unit tests
// Pure logic, no DB.

import { describe, it, expect } from 'vitest';
import {
  filterToolCallsForDelegation,
  buildDeferredToolResults,
} from '../../router/only-one-per-turn.js';
import type { ToolCallBlock } from '../../router/only-one-per-turn.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeBlock(name: string, id?: string): ToolCallBlock {
  return {
    type: 'tool_use',
    id: id ?? `tu_${name}_${Math.random().toString(36).slice(2)}`,
    name,
    input: { task: `do ${name}` },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('filterToolCallsForDelegation', () => {
  it('returns null kept + empty dropped when no assign_* present', () => {
    const calls = [makeBlock('save_memory'), makeBlock('return_result'), makeBlock('web_search')];
    const result = filterToolCallsForDelegation(calls);
    expect(result.kept).toBeNull();
    expect(result.dropped).toHaveLength(0);
    expect(result.others).toHaveLength(3);
  });

  it('keeps the first assign_* and returns nothing dropped', () => {
    const assignA = makeBlock('assign_test_worker_a', 'id_a');
    const calls = [assignA];
    const result = filterToolCallsForDelegation(calls);
    expect(result.kept).toEqual(assignA);
    expect(result.dropped).toHaveLength(0);
  });

  it('keeps only the first assign_* and drops subsequent ones', () => {
    const assignA = makeBlock('assign_test_worker_a', 'id_a');
    const assignB = makeBlock('assign_test_worker_b', 'id_b');
    const assignC = makeBlock('assign_test_worker_c', 'id_c');
    const calls = [assignA, assignB, assignC];

    const result = filterToolCallsForDelegation(calls);
    expect(result.kept?.id).toBe('id_a');
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]?.id).toBe('id_b');
    expect(result.dropped[1]?.id).toBe('id_c');
    expect(result.others).toHaveLength(0);
  });

  it('separates non-assign blocks into others', () => {
    const assignA = makeBlock('assign_test_router_x', 'id_a');
    const assignB = makeBlock('assign_test_worker_y', 'id_b');
    const saveMemory = makeBlock('save_memory', 'id_mem');

    const calls = [assignA, saveMemory, assignB];
    const result = filterToolCallsForDelegation(calls);

    expect(result.kept?.id).toBe('id_a');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.id).toBe('id_b');
    expect(result.others).toHaveLength(1);
    expect(result.others[0]?.id).toBe('id_mem');
  });

  it('handles mixed blocks: return_result + assign — assign takes priority', () => {
    const returnResult = makeBlock('return_result', 'id_rr');
    const assignA = makeBlock('assign_test_agent_z', 'id_a');
    const calls = [returnResult, assignA];

    const result = filterToolCallsForDelegation(calls);
    expect(result.kept?.id).toBe('id_a'); // assign wins
    expect(result.others[0]?.id).toBe('id_rr'); // return_result in others
    expect(result.dropped).toHaveLength(0);
  });
});

describe('buildDeferredToolResults', () => {
  it('returns empty array for no dropped blocks', () => {
    expect(buildDeferredToolResults([])).toHaveLength(0);
  });

  it('builds a tool_result for each dropped block', () => {
    const dropped = [
      makeBlock('assign_test_worker_b', 'id_b'),
      makeBlock('assign_test_worker_c', 'id_c'),
    ];
    const results = buildDeferredToolResults(dropped);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'id_b',
      is_error: true,
    });
    expect(results[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'id_c',
      is_error: true,
    });

    // Content should mention deferral, not a hardcoded agent name
    expect(results[0]?.content).toContain('Deferred');
    expect(results[0]?.content).not.toMatch(/\b(ender|pavel|boris|jennie)\b/i);
  });
});
