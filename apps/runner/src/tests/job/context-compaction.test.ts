// context-compaction.test.ts — pure unit tests for the context-management
// helpers in execute.ts: Guard 1c tool-result eviction + B3 provider-error
// surfacing. No DB; assert on the real transformed result.

import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { compactOldToolResults, describeLlmError } from '../../job/execute.ts';

const asst = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'cortex_get', input: {} }],
});
const tool = (id: string): ModelMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'cortex_get',
      output: { type: 'text', value: `BIG RESULT ${id}` },
    },
  ],
});
function resultValue(m: ModelMessage): string {
  if (m.role !== 'tool' || !Array.isArray(m.content)) return '';
  const p = m.content.find((x) => x.type === 'tool-result');
  return p && p.type === 'tool-result' && p.output.type === 'text' ? String(p.output.value) : '';
}

describe('compactOldToolResults', () => {
  it('evicts tool-result bodies outside the last K tool messages, keeps recent intact', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      asst('a'),
      tool('a'),
      asst('b'),
      tool('b'),
      asst('c'),
      tool('c'),
      asst('d'),
      tool('d'),
    ];
    const { messages: out, evicted } = compactOldToolResults(messages, 2);
    expect(evicted).toBe(2); // a, b evicted; c, d kept
    expect(resultValue(out[2]!)).toContain('elided'); // tool a
    expect(resultValue(out[4]!)).toContain('elided'); // tool b
    expect(resultValue(out[6]!)).toBe('BIG RESULT c'); // intact
    expect(resultValue(out[8]!)).toBe('BIG RESULT d'); // intact
    // Pairing-safe: the evicted tool-result keeps its toolCallId (matches the
    // assistant tool-call), so message-structure validation still passes.
    const evictedMsg = out[2]!;
    const part =
      evictedMsg.role === 'tool' && Array.isArray(evictedMsg.content)
        ? evictedMsg.content[0]
        : undefined;
    expect(part && 'toolCallId' in part ? part.toolCallId : undefined).toBe('a');
  });

  it('is a no-op when tool messages <= keep', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'go' }, asst('a'), tool('a')];
    expect(compactOldToolResults(messages, 3).evicted).toBe(0);
  });

  it('does not re-evict an already-elided result (idempotent)', () => {
    const messages: ModelMessage[] = [
      asst('a'),
      tool('a'),
      asst('b'),
      tool('b'),
      asst('c'),
      tool('c'),
    ];
    const once = compactOldToolResults(messages, 1);
    expect(once.evicted).toBe(2); // a, b → markers; c kept
    const twice = compactOldToolResults(once.messages, 1);
    expect(twice.evicted).toBe(0); // already markers
  });
});

describe('describeLlmError', () => {
  it('splices the real provider responseBody + status into the opaque SDK message', () => {
    const err = Object.assign(new Error('Provider returned error'), {
      statusCode: 400,
      responseBody: 'context_length_exceeded: 1.2M tokens > 128k window',
    });
    const out = describeLlmError(err);
    expect(out).toContain('400');
    expect(out).toContain('context_length_exceeded');
  });

  it('falls back to structured data when responseBody is absent', () => {
    const err = Object.assign(new Error('Bad Request'), { data: { error: 'rate_limited' } });
    expect(describeLlmError(err)).toContain('rate_limited');
  });

  it('uses the plain message when there is no provider detail', () => {
    expect(describeLlmError(new Error('plain failure'))).toBe('plain failure');
  });

  it('returns unknown_error for a non-Error', () => {
    expect(describeLlmError('nope')).toBe('unknown_error');
  });
});
