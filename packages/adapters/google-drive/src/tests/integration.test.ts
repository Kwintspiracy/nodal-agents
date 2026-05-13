// @nodal-agents/adapter-google-drive — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createDriveTools } from '../index';
import { z } from 'zod';

// Use a fake token — tools are instantiated but never called here
const FAKE_TOKEN = 'ya29.fake_integration_test_token';

describe('createDriveTools integration', () => {
  const tools = createDriveTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 12 tools', () => {
    // 5 read + 6 write + 1 destructive = 12
    expect(tools).toHaveLength(12);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case drive_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^drive_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'drive_list_files',
      'drive_read_file',
      'drive_get_file_info',
      'drive_list_permissions',
      'drive_export_file',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'drive_upload_file',
      'drive_create_folder',
      'drive_move_file',
      'drive_rename_file',
      'drive_copy_file',
      'drive_share_file',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['drive_delete_file'];
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

  it('has exactly 6 write tools', () => {
    const writeCount = tools.filter((t) => t.riskLevel === 'write').length;
    expect(writeCount).toBe(6);
  });

  it('has exactly 1 destructive tool', () => {
    const destructiveCount = tools.filter((t) => t.riskLevel === 'destructive').length;
    expect(destructiveCount).toBe(1);
  });

  // Schema spot-checks
  it('drive_list_files schema validates with no args (all optional)', () => {
    const tool = tools.find((t) => t.name === 'drive_list_files')!;
    const parsed = tool.inputSchema.parse({});
    expect(parsed).toBeDefined();
  });

  it('drive_list_files schema validates with query and max_results', () => {
    const tool = tools.find((t) => t.name === 'drive_list_files')!;
    const parsed = tool.inputSchema.parse({ query: 'name contains "resume"', max_results: 50 });
    expect((parsed as { query: string }).query).toBe('name contains "resume"');
  });

  it('drive_read_file schema requires file_id', () => {
    const tool = tools.find((t) => t.name === 'drive_read_file')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ file_id: 'abc123' })).not.toThrow();
  });

  it('drive_delete_file schema requires file_id', () => {
    const tool = tools.find((t) => t.name === 'drive_delete_file')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ file_id: 'file-abc' })).not.toThrow();
  });

  it('drive_share_file schema validates role enum', () => {
    const tool = tools.find((t) => t.name === 'drive_share_file')!;
    expect(() => tool.inputSchema.parse({ file_id: 'f1', role: 'invalid_role' })).toThrow(
      z.ZodError,
    );
    expect(() => tool.inputSchema.parse({ file_id: 'f1', role: 'writer' })).not.toThrow();
  });

  it('drive_export_file schema requires file_id and mime_type', () => {
    const tool = tools.find((t) => t.name === 'drive_export_file')!;
    expect(() => tool.inputSchema.parse({ file_id: 'f1' })).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ file_id: 'f1', mime_type: 'text/plain' })).not.toThrow();
  });

  // Verify all 12 legacy tool names are present
  it('contains all 12 legacy tool names from KwintAgents adapter', () => {
    const legacyNames = [
      'drive_list_files',
      'drive_read_file',
      'drive_upload_file',
      'drive_get_file_info',
      'drive_create_folder',
      'drive_move_file',
      'drive_rename_file',
      'drive_copy_file',
      'drive_delete_file',
      'drive_share_file',
      'drive_list_permissions',
      'drive_export_file',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of legacyNames) {
      expect(toolNames.has(name), `Missing legacy tool: ${name}`).toBe(true);
    }
  });
});
