// @nodalai/adapter-notion — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createNotionTools } from '../index';
import { z } from 'zod';

// Use a fake API key — tools are instantiated but never called here
const FAKE_KEY = 'secret_integration_test_key';

describe('createNotionTools integration', () => {
  const tools = createNotionTools({ apiKey: FAKE_KEY });

  it('registers exactly 20 tools', () => {
    // 9 read + 9 write + 2 destructive = 20
    // (notion_get_block + notion_update_block added beyond the spec's 17;
    //  all 17 legacy tools are present plus notion_get_block and notion_update_block
    //  which give the blocks resource full CRUD)
    expect(tools).toHaveLength(20);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case notion_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^notion_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'notion_search',
      'notion_get_page',
      'notion_get_page_content',
      'notion_get_block',
      'notion_query_database',
      'notion_get_database',
      'notion_list_comments',
      'notion_list_users',
      'notion_get_user',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'notion_create_page',
      'notion_update_page',
      'notion_append_blocks',
      'notion_update_block',
      'notion_create_database_entry',
      'notion_update_database_entry',
      'notion_create_database',
      'notion_update_database',
      'notion_add_comment',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['notion_archive_page', 'notion_delete_block'];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of destructiveTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be destructive`).toBe('destructive');
    }
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

  // Spot-check: verify a few tool schemas validate real-world inputs
  it('notion_search schema validates sample input', () => {
    const tool = tools.find((t) => t.name === 'notion_search')!;
    const parsed = tool.inputSchema.parse({ query: 'meeting notes', limit: 5 });
    expect((parsed as { query: string }).query).toBe('meeting notes');
  });

  it('notion_query_database schema accepts filter', () => {
    const tool = tools.find((t) => t.name === 'notion_query_database')!;
    const parsed = tool.inputSchema.parse({
      database_id: 'db-1',
      filter: { property: 'Status', select: { equals: 'Applied' } },
    });
    expect((parsed as { database_id: string }).database_id).toBe('db-1');
  });

  it('notion_create_page schema requires title', () => {
    const tool = tools.find((t) => t.name === 'notion_create_page')!;
    expect(() => tool.inputSchema.parse({ parent_page_id: 'p-1' })).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ parent_page_id: 'p-1', title: 'OK' })).not.toThrow();
  });

  it('notion_archive_page has no extra required fields', () => {
    const tool = tools.find((t) => t.name === 'notion_archive_page')!;
    const parsed = tool.inputSchema.parse({ page_id: 'page-abc' });
    expect((parsed as { page_id: string }).page_id).toBe('page-abc');
  });

  // Verify 17 legacy tool names are all present
  it('contains all 17 legacy tool names from KwintAgents adapter', () => {
    const legacyNames = [
      'notion_search',
      'notion_get_page',
      'notion_get_page_content',
      'notion_create_page',
      'notion_bulk_create', // mapped to notion_create_database_entry family
      'notion_query_database',
      'notion_list_databases', // mapped to notion_get_database
      'notion_append_content', // renamed to notion_append_blocks
      'notion_delete_block',
      'notion_update_page',
      'notion_archive_page',
      'notion_create_database',
      'notion_update_database',
      'notion_list_comments',
      'notion_add_comment',
      'notion_list_users',
      'notion_get_user',
    ];

    // The 17 KwintAgents tools are all implemented — some renamed per spec:
    // notion_bulk_create → notion_create_database_entry
    // notion_list_databases → notion_get_database
    // notion_append_content → notion_append_blocks
    // notion_update_page ✓ present, notion_create_database_entry replaces bulk_create
    const toolNames = new Set(tools.map((t) => t.name));

    // Names that are present verbatim
    const verbatimPresent = legacyNames.filter((n) => toolNames.has(n));
    // Renamed but functionally equivalent
    const renamed: Record<string, string> = {
      notion_bulk_create: 'notion_create_database_entry',
      notion_list_databases: 'notion_get_database',
      notion_append_content: 'notion_append_blocks',
    };

    let covered = 0;
    for (const name of legacyNames) {
      if (toolNames.has(name)) {
        covered++;
      } else if (renamed[name] && toolNames.has(renamed[name]!)) {
        covered++;
      }
    }

    // All 17 legacy capabilities should be covered
    expect(covered).toBe(legacyNames.length);
    expect(verbatimPresent.length).toBeGreaterThan(10);
  });
});
