// @nodal-agents/adapter-airtable — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation.

import { describe, it, expect } from 'vitest';
import { createAirtableTools } from '../index.ts';
import { z } from 'zod';

const FAKE_TOKEN = 'pat_integration_test_token';

describe('createAirtableTools integration', () => {
  const tools = createAirtableTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 8 tools', () => {
    // 4 read + 3 write + 1 destructive = 8
    expect(tools).toHaveLength(8);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all tool names are snake_case airtable_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^airtable_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'airtable_list_bases',
      'airtable_list_tables',
      'airtable_list_records',
      'airtable_get_record',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'airtable_create_records',
      'airtable_update_record',
      'airtable_replace_record',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(toolMap['airtable_delete_record']?.riskLevel).toBe('destructive');
  });

  it('risk level distribution is 4 read, 3 write, 1 destructive', () => {
    const counts = { read: 0, write: 0, destructive: 0 };
    for (const tool of tools) {
      counts[tool.riskLevel as keyof typeof counts]++;
    }
    expect(counts.read).toBe(4);
    expect(counts.write).toBe(3);
    expect(counts.destructive).toBe(1);
  });

  it('each tool has a valid Zod inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema.parse).toBe('function');
    }
  });

  it('each tool has an execute function', () => {
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  // Schema spot-checks

  it('airtable_list_bases schema accepts empty input', () => {
    const tool = tools.find((t) => t.name === 'airtable_list_bases')!;
    expect(() => tool.inputSchema.parse({})).not.toThrow();
  });

  it('airtable_list_tables schema requires baseId', () => {
    const tool = tools.find((t) => t.name === 'airtable_list_tables')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ baseId: 'appXXX' })).not.toThrow();
  });

  it('airtable_list_records schema requires baseId and tableIdOrName', () => {
    const tool = tools.find((t) => t.name === 'airtable_list_records')!;
    expect(() => tool.inputSchema.parse({ baseId: 'appXXX' })).toThrow(z.ZodError);
    const parsed = tool.inputSchema.parse({ baseId: 'appXXX', tableIdOrName: 'Projects' });
    expect((parsed as { baseId: string }).baseId).toBe('appXXX');
  });

  it('airtable_list_records schema accepts all optional params', () => {
    const tool = tools.find((t) => t.name === 'airtable_list_records')!;
    const parsed = tool.inputSchema.parse({
      baseId: 'appXXX',
      tableIdOrName: 'Tasks',
      view: 'Grid view',
      pageSize: 50,
      filterByFormula: "{Status}='Active'",
      sort: [{ field: 'Name', direction: 'asc' }],
      fields: ['Name', 'Status'],
    });
    expect((parsed as { pageSize: number }).pageSize).toBe(50);
  });

  it('airtable_create_records schema requires records array with min 1', () => {
    const tool = tools.find((t) => t.name === 'airtable_create_records')!;
    expect(() =>
      tool.inputSchema.parse({ baseId: 'appXXX', tableIdOrName: 'Tasks', records: [] }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        baseId: 'appXXX',
        tableIdOrName: 'Tasks',
        records: [{ fields: { Name: 'Test' } }],
      }),
    ).not.toThrow();
  });

  it('airtable_delete_record schema requires baseId, tableIdOrName, recordId', () => {
    const tool = tools.find((t) => t.name === 'airtable_delete_record')!;
    expect(() => tool.inputSchema.parse({ baseId: 'appXXX', tableIdOrName: 'Tasks' })).toThrow(
      z.ZodError,
    );
    expect(() =>
      tool.inputSchema.parse({ baseId: 'appXXX', tableIdOrName: 'Tasks', recordId: 'recXXX' }),
    ).not.toThrow();
  });
});

describe('createAirtableTools — throws on empty token', () => {
  it('throws if accessToken is empty string', () => {
    expect(() => createAirtableTools({ accessToken: '' })).toThrow();
  });
});
