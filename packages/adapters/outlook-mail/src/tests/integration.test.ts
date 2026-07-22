// @nodal-agents/adapter-outlook-mail — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createOutlookMailTools } from '../index';
import { z } from 'zod';

// Use a fake token — tools are instantiated but never called here.
const FAKE_TOKEN = 'fake.integration.test.token';

describe('createOutlookMailTools integration', () => {
  const tools = createOutlookMailTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 15 tools', () => {
    // 5 read + 7 write + 3 destructive = 15
    expect(tools).toHaveLength(15);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case outlook_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^outlook_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'outlook_list_messages',
      'outlook_get_message',
      'outlook_list_drafts',
      'outlook_list_folders',
      'outlook_get_attachment',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'outlook_reply_message',
      'outlook_forward_message',
      'outlook_delete_message',
      'outlook_update_message',
      'outlook_move_message',
      'outlook_create_draft',
      'outlook_update_draft',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['outlook_send_email', 'outlook_send_draft', 'outlook_delete_draft'];
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

  it('has exactly 7 write tools', () => {
    const writeCount = tools.filter((t) => t.riskLevel === 'write').length;
    expect(writeCount).toBe(7);
  });

  it('has exactly 3 destructive tools', () => {
    const destructiveCount = tools.filter((t) => t.riskLevel === 'destructive').length;
    expect(destructiveCount).toBe(3);
  });

  // Schema spot-checks
  it('outlook_list_messages schema validates with no args (all optional)', () => {
    const tool = tools.find((t) => t.name === 'outlook_list_messages')!;
    const parsed = tool.inputSchema.parse({});
    expect(parsed).toBeDefined();
  });

  it('outlook_list_messages schema validates with query, filter and max_results', () => {
    const tool = tools.find((t) => t.name === 'outlook_list_messages')!;
    const parsed = tool.inputSchema.parse({
      query: 'invoice',
      filter: 'isRead eq false',
      max_results: 50,
    });
    expect((parsed as { query: string }).query).toBe('invoice');
  });

  it('outlook_get_message schema requires message_id', () => {
    const tool = tools.find((t) => t.name === 'outlook_get_message')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ message_id: 'abc123' })).not.toThrow();
  });

  it('outlook_send_email schema requires to, subject, body', () => {
    const tool = tools.find((t) => t.name === 'outlook_send_email')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ to: 'alice@example.com', subject: 'Hi', body: 'Hello' }),
    ).not.toThrow();
  });

  it('outlook_delete_message schema requires message_id', () => {
    const tool = tools.find((t) => t.name === 'outlook_delete_message')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ message_id: 'm-1' })).not.toThrow();
  });

  it('outlook_move_message schema requires message_id and destination_folder_id', () => {
    const tool = tools.find((t) => t.name === 'outlook_move_message')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ message_id: 'm-1', destination_folder_id: 'archive' }),
    ).not.toThrow();
  });

  it('outlook_update_message schema allows any single field alone', () => {
    const tool = tools.find((t) => t.name === 'outlook_update_message')!;
    expect(() => tool.inputSchema.parse({ message_id: 'm-1', is_read: true })).not.toThrow();
    expect(() => tool.inputSchema.parse({ message_id: 'm-1', categories: ['Blue'] })).not.toThrow();
  });

  it('outlook_delete_draft schema requires draft_id', () => {
    const tool = tools.find((t) => t.name === 'outlook_delete_draft')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ draft_id: 'd-123456' })).not.toThrow();
  });

  it('outlook_reply_message schema validates reply_all as boolean', () => {
    const tool = tools.find((t) => t.name === 'outlook_reply_message')!;
    expect(() =>
      tool.inputSchema.parse({ message_id: 'm-1', comment: 'Thanks', reply_all: 'yes' }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ message_id: 'm-1', comment: 'Thanks', reply_all: true }),
    ).not.toThrow();
  });

  it('contains all 15 expected tool names', () => {
    const expected = [
      'outlook_list_messages',
      'outlook_get_message',
      'outlook_send_email',
      'outlook_reply_message',
      'outlook_forward_message',
      'outlook_delete_message',
      'outlook_update_message',
      'outlook_move_message',
      'outlook_list_drafts',
      'outlook_create_draft',
      'outlook_update_draft',
      'outlook_send_draft',
      'outlook_delete_draft',
      'outlook_list_folders',
      'outlook_get_attachment',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of expected) {
      expect(toolNames.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });
});
