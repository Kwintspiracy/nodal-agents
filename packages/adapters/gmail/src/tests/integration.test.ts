// @nodalai/adapter-gmail — integration test
// Verifies: tool count, unique names, correct risk levels, schema validation

import { describe, it, expect } from 'vitest';
import { createGmailTools } from '../index';
import { z } from 'zod';

// Use a fake token — tools are instantiated but never called here
const FAKE_TOKEN = 'ya29.fake_integration_test_token';

describe('createGmailTools integration', () => {
  const tools = createGmailTools({ accessToken: FAKE_TOKEN });

  it('registers exactly 25 tools', () => {
    // 9 read + 13 write + 3 destructive = 25
    expect(tools).toHaveLength(25);
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool names are snake_case gmail_* strings', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^gmail_[a-z_]+$/);
    }
  });

  it('all tools have a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('read tools have riskLevel read', () => {
    const readTools = [
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_list_threads',
      'gmail_get_thread',
      'gmail_list_labels',
      'gmail_get_label',
      'gmail_list_drafts',
      'gmail_get_attachment',
      'gmail_list_history',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of readTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be read`).toBe('read');
    }
  });

  it('write tools have riskLevel write', () => {
    const writeTools = [
      'gmail_send_email',
      'gmail_reply_message',
      'gmail_forward_message',
      'gmail_modify_labels',
      'gmail_trash_message',
      'gmail_untrash_message',
      'gmail_modify_thread_labels',
      'gmail_trash_thread',
      'gmail_create_label',
      'gmail_update_label',
      'gmail_create_draft',
      'gmail_update_draft',
      'gmail_send_draft',
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of writeTools) {
      expect(toolMap[name]?.riskLevel, `${name} should be write`).toBe('write');
    }
  });

  it('destructive tools have riskLevel destructive', () => {
    const destructiveTools = ['gmail_delete_message', 'gmail_delete_label', 'gmail_delete_draft'];
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
  it('has exactly 9 read tools', () => {
    const readCount = tools.filter((t) => t.riskLevel === 'read').length;
    expect(readCount).toBe(9);
  });

  it('has exactly 13 write tools', () => {
    const writeCount = tools.filter((t) => t.riskLevel === 'write').length;
    expect(writeCount).toBe(13);
  });

  it('has exactly 3 destructive tools', () => {
    const destructiveCount = tools.filter((t) => t.riskLevel === 'destructive').length;
    expect(destructiveCount).toBe(3);
  });

  // Schema spot-checks
  it('gmail_list_messages schema validates with no args (all optional)', () => {
    const tool = tools.find((t) => t.name === 'gmail_list_messages')!;
    const parsed = tool.inputSchema.parse({});
    expect(parsed).toBeDefined();
  });

  it('gmail_list_messages schema validates with query and max_results', () => {
    const tool = tools.find((t) => t.name === 'gmail_list_messages')!;
    const parsed = tool.inputSchema.parse({ query: 'is:unread', max_results: 50 });
    expect((parsed as { query: string }).query).toBe('is:unread');
  });

  it('gmail_get_message schema requires message_id', () => {
    const tool = tools.find((t) => t.name === 'gmail_get_message')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ message_id: 'abc123' })).not.toThrow();
  });

  it('gmail_send_email schema requires to, subject, body', () => {
    const tool = tools.find((t) => t.name === 'gmail_send_email')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ to: 'alice@example.com', subject: 'Hi', body: 'Hello' }),
    ).not.toThrow();
  });

  it('gmail_delete_message schema requires message_id', () => {
    const tool = tools.find((t) => t.name === 'gmail_delete_message')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ message_id: 'msg-1' })).not.toThrow();
  });

  it('gmail_delete_label schema requires label_id', () => {
    const tool = tools.find((t) => t.name === 'gmail_delete_label')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ label_id: 'Label_123' })).not.toThrow();
  });

  it('gmail_delete_draft schema requires draft_id', () => {
    const tool = tools.find((t) => t.name === 'gmail_delete_draft')!;
    expect(() => tool.inputSchema.parse({})).toThrow(z.ZodError);
    expect(() => tool.inputSchema.parse({ draft_id: 'r-123456' })).not.toThrow();
  });

  it('gmail_create_label schema validates visibility enums', () => {
    const tool = tools.find((t) => t.name === 'gmail_create_label')!;
    expect(() =>
      tool.inputSchema.parse({ name: 'Test', label_list_visibility: 'invalid' }),
    ).toThrow(z.ZodError);
    expect(() =>
      tool.inputSchema.parse({ name: 'Test', label_list_visibility: 'labelShow' }),
    ).not.toThrow();
  });

  it('gmail_modify_labels schema validates with add and remove arrays', () => {
    const tool = tools.find((t) => t.name === 'gmail_modify_labels')!;
    expect(() =>
      tool.inputSchema.parse({
        message_id: 'msg-1',
        add_labels: ['STARRED'],
        remove_labels: ['UNREAD'],
      }),
    ).not.toThrow();
  });

  it('gmail_list_labels schema validates with empty object', () => {
    const tool = tools.find((t) => t.name === 'gmail_list_labels')!;
    expect(() => tool.inputSchema.parse({})).not.toThrow();
  });

  // Verify core legacy tool names are present (expanded set)
  it('contains all legacy tool names from KwintAgents adapter', () => {
    const legacyNames = [
      'gmail_send_email',
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_reply_message',
      'gmail_modify_labels',
      'gmail_trash_message',
      'gmail_create_draft',
      'gmail_update_draft',
      'gmail_list_drafts',
      'gmail_send_draft',
      'gmail_delete_draft',
      'gmail_list_labels',
      'gmail_create_label',
      'gmail_delete_label',
      'gmail_get_thread',
      'gmail_forward_message',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of legacyNames) {
      expect(toolNames.has(name), `Missing legacy tool: ${name}`).toBe(true);
    }
  });

  // Verify new tools beyond legacy
  it('contains new tools beyond legacy coverage', () => {
    const newTools = [
      'gmail_list_threads',
      'gmail_get_label',
      'gmail_update_label',
      'gmail_modify_thread_labels',
      'gmail_trash_thread',
      'gmail_delete_message',
      'gmail_untrash_message',
      'gmail_get_attachment',
      'gmail_list_history',
    ];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of newTools) {
      expect(toolNames.has(name), `Missing new tool: ${name}`).toBe(true);
    }
  });
});
