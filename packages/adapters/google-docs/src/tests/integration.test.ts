// @nodalai/adapter-google-docs — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createDocsTools } from '../index';
import { z } from 'zod';

// Use a fake token — tools are instantiated but never called here
const FAKE_TOKEN = 'ya29.fake_integration_test_token';

describe('createDocsTools integration', () => {
  const tools = createDocsTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 14 tools', () => {
    // 2 read + 11 write + 1 destructive = 14
    expect(tools).toHaveLength(14);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case docs_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^docs_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = ['docs_get', 'docs_get_text'];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'docs_create',
      'docs_insert_text',
      'docs_append_text',
      'docs_replace_text',
      'docs_insert_paragraph',
      'docs_insert_page_break',
      'docs_insert_table',
      'docs_insert_image',
      'docs_format_text',
      'docs_apply_named_style',
      'docs_batch_update',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['docs_delete_content_range'];
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

  // Tool count breakdown
  it('has exactly 2 read tools', () => {
    const readCount = tools.filter((t) => t.riskLevel === 'read').length;
    expect(readCount).toBe(2);
  });

  it('has exactly 11 write tools', () => {
    const writeCount = tools.filter((t) => t.riskLevel === 'write').length;
    expect(writeCount).toBe(11);
  });

  it('has exactly 1 destructive tool', () => {
    const destructiveCount = tools.filter((t) => t.riskLevel === 'destructive').length;
    expect(destructiveCount).toBe(1);
  });

  // Schema spot-checks
  it('docs_get schema requires document_id', () => {
    const tool = tools.find((t) => t.name === 'docs_get')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ document_id: 'abc123' })).not.toThrow();
  });

  it('docs_create schema requires title, content optional', () => {
    const tool = tools.find((t) => t.name === 'docs_create')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ title: 'My Doc' })).not.toThrow();
    expect(() => tool.inputSchema.parse({ title: 'My Doc', content: 'Hello world' })).not.toThrow();
  });

  it('docs_insert_text schema requires document_id, text, index', () => {
    const tool = tools.find((t) => t.name === 'docs_insert_text')!;
    expect(() => tool.inputSchema.parse({ document_id: 'abc' })).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', text: 'Hello', index: 1 }),
    ).not.toThrow();
  });

  it('docs_replace_text schema requires document_id, find, replace', () => {
    const tool = tools.find((t) => t.name === 'docs_replace_text')!;
    expect(() => tool.inputSchema.parse({ document_id: 'abc', find: 'x' })).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', find: 'foo', replace: 'bar' }),
    ).not.toThrow();
  });

  it('docs_delete_content_range schema requires document_id, start_index, end_index', () => {
    const tool = tools.find((t) => t.name === 'docs_delete_content_range')!;
    expect(() => tool.inputSchema.parse({ document_id: 'abc', start_index: 1 })).toThrow(
      z.ZodError,
    );
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', start_index: 1, end_index: 10 }),
    ).not.toThrow();
  });

  it('docs_insert_table schema validates rows and columns bounds', () => {
    const tool = tools.find((t) => t.name === 'docs_insert_table')!;
    // rows min=1
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', index: 1, rows: 0, columns: 3 }),
    ).toThrow(z.ZodError);
    // columns max=20
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', index: 1, rows: 3, columns: 21 }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', index: 1, rows: 3, columns: 3 }),
    ).not.toThrow();
  });

  it('docs_format_text schema requires document_id, start_index, end_index', () => {
    const tool = tools.find((t) => t.name === 'docs_format_text')!;
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', start_index: 1, bold: true }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', start_index: 1, end_index: 10, bold: true }),
    ).not.toThrow();
  });

  it('docs_apply_named_style schema validates named_style enum', () => {
    const tool = tools.find((t) => t.name === 'docs_apply_named_style')!;
    expect(() =>
      tool.inputSchema.parse({
        document_id: 'abc',
        start_index: 1,
        end_index: 10,
        named_style: 'NOT_VALID',
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        document_id: 'abc',
        start_index: 1,
        end_index: 10,
        named_style: 'HEADING_1',
      }),
    ).not.toThrow();
  });

  it('docs_batch_update requires non-empty requests array', () => {
    const tool = tools.find((t) => t.name === 'docs_batch_update')!;
    expect(() => tool.inputSchema.parse({ document_id: 'abc', requests: [] })).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        document_id: 'abc',
        requests: [{ insertText: { location: { index: 1 }, text: 'hi' } }],
      }),
    ).not.toThrow();
  });

  it('docs_insert_image requires a valid URL', () => {
    const tool = tools.find((t) => t.name === 'docs_insert_image')!;
    expect(() =>
      tool.inputSchema.parse({ document_id: 'abc', index: 1, image_uri: 'not-a-url' }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        document_id: 'abc',
        index: 1,
        image_uri: 'https://example.com/image.png',
      }),
    ).not.toThrow();
  });

  // Legacy tool names (4 from Python adapter)
  it('contains all 4 legacy tool names from KwintAgents adapter', () => {
    // Note: legacy had 'docs_append' — we renamed to docs_append_text for consistency
    const toolNames = new Set(tools.map((t) => t.name));
    // docs_get and docs_replace_text are direct matches
    expect(toolNames.has('docs_get'), 'Missing docs_get').toBe(true);
    expect(toolNames.has('docs_replace_text'), 'Missing docs_replace_text').toBe(true);
    expect(toolNames.has('docs_create'), 'Missing docs_create').toBe(true);
    // docs_append → docs_append_text (renamed for consistency)
    expect(toolNames.has('docs_append_text'), 'Missing docs_append_text (was docs_append)').toBe(
      true,
    );
  });

  // New tools beyond legacy
  it('contains new tools beyond legacy coverage', () => {
    const newTools = [
      'docs_get_text',
      'docs_insert_text',
      'docs_delete_content_range',
      'docs_insert_paragraph',
      'docs_insert_page_break',
      'docs_insert_table',
      'docs_insert_image',
      'docs_format_text',
      'docs_apply_named_style',
      'docs_batch_update',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of newTools) {
      expect(toolNames.has(name), `Missing new tool: ${name}`).toBe(true);
    }
  });
});
