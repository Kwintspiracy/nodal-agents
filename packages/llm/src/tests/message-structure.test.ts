// message-structure.test.ts — all resilience.py invariants encoded

import { describe, it, expect } from 'vitest';
import { validateMessageStructure } from '../message-structure';
import { MessageStructureError } from '../errors';
import type { ModelMessage } from 'ai';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function assistantWithToolCall(toolCallId: string, toolName = 'do_thing'): ModelMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        input: { input: 'x' },
      },
    ],
  };
}

function toolResult(toolCallId: string, toolName = 'do_thing', result = 'ok'): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: result } },
    ],
  };
}

function assistantText(text = 'done'): ModelMessage {
  return { role: 'assistant', content: text };
}

function userMessage(text = 'hello'): ModelMessage {
  return { role: 'user', content: text };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('validateMessageStructure', () => {
  // Happy paths
  it('passes on empty message list', () => {
    expect(() => validateMessageStructure([])).not.toThrow();
  });

  it('passes on user-only messages', () => {
    expect(() => validateMessageStructure([userMessage(), userMessage('hello2')])).not.toThrow();
  });

  it('passes on assistant text-only messages', () => {
    expect(() => validateMessageStructure([userMessage(), assistantText()])).not.toThrow();
  });

  it('passes on a well-formed tool call + result pair', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      toolResult('tc1'),
    ];
    expect(() => validateMessageStructure(messages)).not.toThrow();
  });

  it('passes on multiple tool call + result pairs', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      toolResult('tc1'),
      userMessage('next'),
      assistantWithToolCall('tc2'),
      toolResult('tc2'),
    ];
    expect(() => validateMessageStructure(messages)).not.toThrow();
  });

  it('passes on assistant message with multiple tool calls all resolved', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'a', input: {} },
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'b', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'a',
            output: { type: 'text', value: 'r1' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc2',
            toolName: 'b',
            output: { type: 'text', value: 'r2' },
          },
        ],
      },
    ];
    expect(() => validateMessageStructure(messages)).not.toThrow();
  });

  // Invariant 3: unresolved_tail
  it('throws unresolved_tail when conversation ends on assistant with tool calls', () => {
    const messages: ModelMessage[] = [userMessage(), assistantWithToolCall('tc1')];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('unresolved_tail');
    }
  });

  // Invariant 1: unmatched_tool_use — next message is user, not tool
  it('throws unmatched_tool_use when tool call is followed by user message instead of tool result', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      userMessage('wrong'),
    ];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('unmatched_tool_use');
    }
  });

  // Invariant 1: unmatched_tool_use — tool result present but for different id
  it('throws unmatched_tool_use when tool result id does not match tool call id', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      toolResult('tc-WRONG'), // wrong id
    ];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('unmatched_tool_use');
      expect((e as MessageStructureError).context).toMatchObject({ toolCallId: 'tc1' });
    }
  });

  // Invariant 1: only one of two tool calls resolved
  it('throws unmatched_tool_use when only one of two tool calls is resolved', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'a', input: {} },
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'b', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'a',
            output: { type: 'text', value: 'r1' },
          },
          // tc2 missing
        ],
      },
    ];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('unmatched_tool_use');
    }
  });

  // Invariant 2: duplicate_tool_use_id
  it('throws duplicate_tool_use_id when same id appears twice', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      toolResult('tc1'),
      userMessage('next'),
      assistantWithToolCall('tc1'), // duplicate
      toolResult('tc1'),
    ];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('duplicate_tool_use_id');
      expect((e as MessageStructureError).context).toMatchObject({ toolCallId: 'tc1' });
    }
  });

  // Invariant 4: missing_tool_result_content
  it('throws missing_tool_result_content when result is null', () => {
    const messages: ModelMessage[] = [
      userMessage(),
      assistantWithToolCall('tc1'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'do_thing',
            output: undefined as never,
          },
        ],
      },
    ];
    expect(() => validateMessageStructure(messages)).toThrow(MessageStructureError);
    try {
      validateMessageStructure(messages);
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      expect((e as MessageStructureError).code).toBe('missing_tool_result_content');
    }
  });

  // MessageStructureError carries code + context
  it('MessageStructureError has the correct code and context fields', () => {
    const messages: ModelMessage[] = [userMessage(), assistantWithToolCall('tc-abc')];
    try {
      validateMessageStructure(messages);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MessageStructureError);
      const err = e as MessageStructureError;
      expect(err.code).toBe('unresolved_tail');
      expect(err.context).toBeDefined();
      expect(typeof err.context).toBe('object');
    }
  });
});
