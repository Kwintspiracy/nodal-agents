// tool-result-shape.test.ts — the shape of a transcript block no longer says
// whether a call worked (#1184). The loop's same-turn guard reads the outcome
// the seam returned with the result; the only fact still read on a block is
// the transcript's own (a result removed by the compaction).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVICTED_TOOL_RESULT_MARKER, isElidedToolResult } from '../../job/tool-result-shape.ts';

describe('a block is a transcript fact, not an outcome @cap:parler-a-un-agent/moteur', () => {
  it('only the compaction marker is read on a block', () => {
    expect(isElidedToolResult({ type: 'text', value: EVICTED_TOOL_RESULT_MARKER })).toBe(true);
    // An error block, a success, a returned failure: none of them is elided,
    // and none is classified here any more.
    expect(isElidedToolResult({ type: 'json', value: { error: 'EACCES' } })).toBe(false);
    expect(isElidedToolResult({ type: 'json', value: { ok: false, reason: 'x' } })).toBe(false);
    expect(isElidedToolResult({ type: 'text', value: 'plain result' })).toBe(false);
  });

  it('the same-turn guard reads the outcome of the call, never the text of its block', () => {
    const execute = readFileSync(
      fileURLToPath(new URL('../../job/execute.ts', import.meta.url)),
      'utf8',
    );
    expect(execute).toMatch(/isToolErrorBlock[\s\S]{0,200}turnOutcomes\.get\(block\.toolCallId\)/);
    expect(execute).not.toContain('toolResultShape');
    expect(execute).not.toContain(`startsWith('{"error":')`);
  });
});
