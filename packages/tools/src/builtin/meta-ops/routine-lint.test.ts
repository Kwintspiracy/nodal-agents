// meta-ops/routine-lint.test.ts — unit tests for lintRoutineTask (H1b).
// Pure function — no DB. Asserts on the real warnings array, not call counts.

import { describe, it, expect } from 'vitest';
import { lintRoutineTask } from './routine-lint';

describe('lintRoutineTask — ambiguous "state" phrasing', () => {
  it('flags the real incident text', () => {
    const { warnings } = lintRoutineTask(
      'Retrieve the previously stored version from your state and compare it to the latest.',
      new Set(['query_memory', 'save_memory', 'return_result']),
    );
    expect(warnings.some((w) => w.toLowerCase().includes('state'))).toBe(true);
  });

  it('does not flag routine text that never mentions state', () => {
    const { warnings } = lintRoutineTask(
      'Check the inbox and summarize any new messages.',
      new Set(['query_memory', 'save_memory', 'return_result']),
    );
    expect(warnings).toEqual([]);
  });
});

describe('lintRoutineTask — unavailable tool references', () => {
  it('flags a backtick-quoted MCP tool the agent does not have', () => {
    const { warnings } = lintRoutineTask(
      'Call `cogni_cortex__get_state` to fetch the last snapshot.',
      new Set(['query_memory', 'save_memory', 'return_result']),
    );
    expect(warnings.some((w) => w.includes('cogni_cortex__get_state'))).toBe(true);
  });

  it('flags a bare meta/assign-shaped identifier not in availableTools', () => {
    const { warnings } = lintRoutineTask(
      'Use assign_researcher to delegate the search.',
      new Set(['query_memory', 'save_memory', 'return_result']),
    );
    expect(warnings.some((w) => w.includes('assign_researcher'))).toBe(true);
  });

  it('offers a "did you mean" hint when a close match exists', () => {
    const { warnings } = lintRoutineTask(
      'Call `mcp_fetch__fetch_markdow` to grab the page.',
      new Set(['mcp_fetch__fetch_markdown', 'query_memory', 'save_memory', 'return_result']),
    );
    const w = warnings.find((x) => x.includes('mcp_fetch__fetch_markdow'));
    expect(w).toBeDefined();
    expect(w).toContain('did you mean');
    expect(w).toContain('mcp_fetch__fetch_markdown');
  });

  it('produces ZERO warnings for a clean routine using only available tools', () => {
    const { warnings } = lintRoutineTask(
      'Use `mcp_fetch__fetch_markdown` to fetch the page, then `query_memory` for context, ' +
        '`save_memory` to persist a summary, and finish with `return_result`.',
      new Set(['mcp_fetch__fetch_markdown', 'query_memory', 'save_memory', 'return_result']),
    );
    expect(warnings).toEqual([]);
  });

  it('does not flag ordinary snake_case prose without __ or a meta/assign prefix', () => {
    const { warnings } = lintRoutineTask(
      'Do a day_to_day review and keep it low_key.',
      new Set(['return_result']),
    );
    expect(warnings).toEqual([]);
  });
});
