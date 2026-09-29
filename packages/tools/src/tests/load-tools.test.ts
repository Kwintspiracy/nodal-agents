// load-tools.test.ts — the loader and the index a job's deferred tools get (#612).

import { describe, it, expect } from 'vitest';
import {
  ALWAYS_ON_TOOL_DOCS,
  createLoadToolsTool,
  createToolRegistry,
  deferredToolIndex,
  registerBuiltins,
  toolIndexLine,
} from '../index';
import type { ToolContext } from '../types';

const TOOLS = [
  { name: 'return_result', description: 'Finish the job.', loading: 'eager' as const },
  { name: 'list_schedules', description: 'List the schedules. Long details follow here.' },
  {
    name: 'mcp_fetch__fetch_html',
    description: 'Fetch a URL and return its raw HTML. More.',
    loading: 'deferred' as const,
  },
];

const ctx = {} as ToolContext;

describe('load_tools loads only the job’s own deferred tools @cap:assigner-outils/moteur', () => {
  it('loads a deferred tool, reports an eager one as already there, refuses one not held', async () => {
    const tool = createLoadToolsTool(TOOLS);
    const out = await tool.execute(
      { names: ['list_schedules', 'return_result', 'run_command', 'mcp_fetch__fetch_html'] },
      ctx,
    );
    expect(out.loaded).toEqual(['list_schedules', 'mcp_fetch__fetch_html']);
    expect(out.alreadyAvailable).toEqual(['return_result']);
    expect(out.notHeld).toEqual(['run_command']);
    expect(out.message).toContain('Not tools you hold: run_command.');
  });

  it('a name asked twice is loaded once', async () => {
    const out = await createLoadToolsTool(TOOLS).execute(
      { names: ['list_schedules', ' list_schedules '] },
      ctx,
    );
    expect(out.loaded).toEqual(['list_schedules']);
  });

  it('is itself eager and read-only', () => {
    const tool = createLoadToolsTool(TOOLS);
    expect(tool.loading).toBe('eager');
    expect(tool.riskLevel).toBe('read');
  });
});

describe('the tool index @cap:assigner-outils/moteur', () => {
  it('names every deferred tool — absent loading included — with its first sentence', () => {
    expect(deferredToolIndex(TOOLS)).toEqual([
      { name: 'list_schedules', line: 'List the schedules.' },
      { name: 'mcp_fetch__fetch_html', line: 'Fetch a URL and return its raw HTML.' },
    ]);
  });

  it('cuts a sentence longer than one line, and flattens whitespace', () => {
    const line = toolIndexLine(`Do ${'x '.repeat(200)}now.`);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.startsWith('Do x x')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(toolIndexLine('Two\n  lines here')).toBe('Two lines here');
  });

  it('the always-on docs carry the loading their tool declares', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    for (const doc of ALWAYS_ON_TOOL_DOCS) {
      expect(doc.loading, doc.name).toBe(registry.get(doc.name)?.loading ?? 'deferred');
    }
    // The builtins a turn relies on without asking first.
    const eager = ALWAYS_ON_TOOL_DOCS.filter((d) => d.loading === 'eager').map((d) => d.name);
    expect(eager).toEqual(
      expect.arrayContaining(['return_result', 'ask_user', 'file_read', 'query_memory']),
    );
    expect(eager).not.toContain('register_project');
  });
});
