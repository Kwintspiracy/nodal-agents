// Chat vs task classification (migration 0059 — Jobs page grouping).
// Derived purely from tools_used, so these matrices are the source of truth
// for what counts as "just talking" vs "did something".

import { describe, it, expect } from 'vitest';
import { classifyJob } from '../entities/job-classification';

describe('classifyJob', () => {
  it('classifies an empty tools_used as chat', () => {
    expect(classifyJob([])).toBe('chat');
    expect(classifyJob(null)).toBe('chat');
    expect(classifyJob(undefined)).toBe('chat');
  });

  it('classifies pure delivery/terminal tools as chat', () => {
    expect(classifyJob(['telegram_send_message'])).toBe('chat');
    expect(classifyJob(['return_result'])).toBe('chat');
    expect(classifyJob(['telegram_send_message', 'return_result'])).toBe('chat');
    expect(classifyJob(['send_image', 'send_file', 'send_video', 'send_audio', 'send_voice'])).toBe(
      'chat',
    );
    expect(classifyJob(['dashboard_publish'])).toBe('chat');
  });

  it('classifies a chat that also consulted context (pure reads) as chat', () => {
    expect(classifyJob(['query_memory', 'telegram_send_message'])).toBe('chat');
    expect(classifyJob(['search_history', 'skill_view', 'return_result'])).toBe('chat');
    expect(classifyJob(['list_models', 'file_read', 'file_list', 'file_search'])).toBe('chat');
  });

  it('classifies any non-listed tool as task', () => {
    expect(classifyJob(['run_command'])).toBe('task');
    expect(classifyJob(['telegram_send_message', 'run_command'])).toBe('task');
    expect(classifyJob(['create_task'])).toBe('task');
    expect(classifyJob(['assign_summarizer'])).toBe('task');
    expect(classifyJob(['notion_search'])).toBe('task'); // adapter tool
  });

  it('classifies write/outbound always-on tools as task (not pure context reads)', () => {
    expect(classifyJob(['file_write'])).toBe('task');
    expect(classifyJob(['file_edit'])).toBe('task');
    expect(classifyJob(['save_memory'])).toBe('task');
    expect(classifyJob(['mark_memory_helpful'])).toBe('task');
    expect(classifyJob(['mark_memory_outdated'])).toBe('task');
    expect(classifyJob(['web_search'])).toBe('task');
  });

  it('one task-shaped tool among many chat-shaped tools still tips to task', () => {
    expect(
      classifyJob(['query_memory', 'telegram_send_message', 'return_result', 'run_command']),
    ).toBe('task');
  });
});
