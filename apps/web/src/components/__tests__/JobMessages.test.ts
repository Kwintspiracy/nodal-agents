import { describe, it, expect } from 'vitest';
import { blocksFromContent } from '../JobMessages';

describe('blocksFromContent — tool-result extraction across SDK shapes', () => {
  it('extracts payload from AI SDK v6 shape (output.value)', () => {
    const content = [
      {
        type: 'tool-result',
        toolName: 'save_memory',
        toolCallId: 'call_abc',
        output: { type: 'json', value: { saved: false, reason: 'Blocked: prompt_injection' } },
      },
    ];
    const blocks = blocksFromContent(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool-result',
      toolName: 'save_memory',
      toolCallId: 'call_abc',
      payload: { saved: false, reason: 'Blocked: prompt_injection' },
    });
  });

  it('extracts payload from AI SDK v6 text output shape', () => {
    const content = [
      {
        type: 'tool-result',
        toolName: 'web_search',
        toolCallId: 'call_xyz',
        output: { type: 'text', value: 'plain string result' },
      },
    ];
    const blocks = blocksFromContent(content);
    expect(blocks[0]?.payload).toBe('plain string result');
  });

  it('extracts payload from AI SDK v4 shape (result field)', () => {
    const content = [
      {
        type: 'tool-result',
        toolName: 'query_memory',
        toolCallId: 'call_v4',
        result: { memories: [{ id: '1', fact: 'foo' }] },
      },
    ];
    const blocks = blocksFromContent(content);
    expect(blocks[0]?.payload).toEqual({ memories: [{ id: '1', fact: 'foo' }] });
  });

  it('extracts payload from Anthropic legacy shape (content field)', () => {
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_legacy',
        content: 'legacy string content',
      },
    ];
    const blocks = blocksFromContent(content);
    expect(blocks[0]).toMatchObject({
      kind: 'tool-result',
      toolCallId: 'toolu_legacy',
      payload: 'legacy string content',
    });
  });

  it('falls back to null when no known payload field is present', () => {
    const content = [
      {
        type: 'tool-result',
        toolName: 'mystery',
        toolCallId: 'c1',
      },
    ];
    expect(blocksFromContent(content)[0]?.payload).toBeNull();
  });
});
