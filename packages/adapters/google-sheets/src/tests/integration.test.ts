// @nodalai/adapter-google-sheets — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createSheetsTools } from '../index';
import { z } from 'zod';

// Use a fake token — tools are instantiated but never called here
const FAKE_TOKEN = 'ya29.fake_integration_test_token';

describe('createSheetsTools integration', () => {
  const tools = createSheetsTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 20 tools', () => {
    // 5 read + 14 write + 1 destructive = 20
    expect(tools).toHaveLength(20);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case sheets_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^sheets_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'sheets_read_range',
      'sheets_read_all',
      'sheets_batch_read_ranges',
      'sheets_get_metadata',
      'sheets_find_rows',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'sheets_write_range',
      'sheets_append_row',
      'sheets_clear_range',
      'sheets_batch_update_values',
      'sheets_create_spreadsheet',
      'sheets_add_sheet',
      'sheets_duplicate_sheet',
      'sheets_rename_sheet',
      'sheets_format_range',
      'sheets_resize_columns',
      'sheets_freeze_panes',
      'sheets_set_basic_filter',
      'sheets_clear_basic_filter',
      'sheets_sort_range',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['sheets_delete_sheet'];
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
  it('has exactly 5 read tools', () => {
    const readCount = tools.filter((t) => t.riskLevel === 'read').length;
    expect(readCount).toBe(5);
  });

  it('has exactly 14 write tools', () => {
    const writeCount = tools.filter((t) => t.riskLevel === 'write').length;
    expect(writeCount).toBe(14);
  });

  it('has exactly 1 destructive tool', () => {
    const destructiveCount = tools.filter((t) => t.riskLevel === 'destructive').length;
    expect(destructiveCount).toBe(1);
  });

  // Schema spot-checks
  it('sheets_read_range schema requires spreadsheet_id and range', () => {
    const tool = tools.find((t) => t.name === 'sheets_read_range')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ spreadsheet_id: 'abc', range: 'Sheet1!A1:C10' }),
    ).not.toThrow();
  });

  it('sheets_read_all schema requires spreadsheet_id, sheet_name optional', () => {
    const tool = tools.find((t) => t.name === 'sheets_read_all')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc' })).not.toThrow();
    expect(() =>
      tool.inputSchema.parse({ spreadsheet_id: 'abc', sheet_name: 'Tab1' }),
    ).not.toThrow();
  });

  it('sheets_write_range schema requires spreadsheet_id, range, values', () => {
    const tool = tools.find((t) => t.name === 'sheets_write_range')!;
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc', range: 'A1' })).toThrow(
      z.ZodError,
    );
    expect(() =>
      tool.inputSchema.parse({
        spreadsheet_id: 'abc',
        range: 'Sheet1!A1',
        values: [['Name', 'Score']],
      }),
    ).not.toThrow();
  });

  it('sheets_append_row schema requires spreadsheet_id, range, values', () => {
    const tool = tools.find((t) => t.name === 'sheets_append_row')!;
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc' })).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        spreadsheet_id: 'abc',
        range: 'Sheet1',
        values: [['Alice', 95]],
      }),
    ).not.toThrow();
  });

  it('sheets_delete_sheet schema requires spreadsheet_id and sheet_id', () => {
    const tool = tools.find((t) => t.name === 'sheets_delete_sheet')!;
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc' })).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc', sheet_id: 0 })).not.toThrow();
  });

  it('sheets_format_range schema validates required fields', () => {
    const tool = tools.find((t) => t.name === 'sheets_format_range')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 0,
        end_row_index: 1,
        start_column_index: 0,
        end_column_index: 3,
        bold: true,
      }),
    ).not.toThrow();
  });

  it('sheets_sort_range sort_specs must be non-empty array', () => {
    const tool = tools.find((t) => t.name === 'sheets_sort_range')!;
    expect(() =>
      tool.inputSchema.parse({
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 1,
        end_row_index: 100,
        start_column_index: 0,
        end_column_index: 5,
        sort_specs: [],
      }),
    ).toThrow(z.ZodError);
  });

  it('sheets_batch_read_ranges requires at least one range', () => {
    const tool = tools.find((t) => t.name === 'sheets_batch_read_ranges')!;
    expect(() => tool.inputSchema.parse({ spreadsheet_id: 'abc', ranges: [] })).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ spreadsheet_id: 'abc', ranges: ['Sheet1!A1:C10'] }),
    ).not.toThrow();
  });

  // Legacy tool names (all 6 from Python adapter)
  it('contains all 6 legacy tool names from KwintAgents adapter', () => {
    const legacyNames = [
      'sheets_read_all',
      'sheets_read_range',
      'sheets_write_range',
      'sheets_append_row',
      'sheets_find_rows',
      'sheets_get_metadata',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of legacyNames) {
      expect(toolNames.has(name), `Missing legacy tool: ${name}`).toBe(true);
    }
  });

  // New tools beyond legacy
  it('contains new tools beyond legacy coverage', () => {
    const newTools = [
      'sheets_batch_read_ranges',
      'sheets_clear_range',
      'sheets_batch_update_values',
      'sheets_create_spreadsheet',
      'sheets_add_sheet',
      'sheets_delete_sheet',
      'sheets_duplicate_sheet',
      'sheets_rename_sheet',
      'sheets_format_range',
      'sheets_resize_columns',
      'sheets_freeze_panes',
      'sheets_set_basic_filter',
      'sheets_clear_basic_filter',
      'sheets_sort_range',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of newTools) {
      expect(toolNames.has(name), `Missing new tool: ${name}`).toBe(true);
    }
  });
});
