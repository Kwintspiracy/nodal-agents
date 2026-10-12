// tool-result-frame-fit.test.ts — a third party's result is cut to fit, THEN
// framed, within the one budget the model reads (INJECT-001).
//
// Not specific to MCP: every untrusted tool (web_search, file_read, the
// connector families, MCP) goes through the same two functions. Cutting AFTER
// framing could remove the closing delimiter — everything after an opening
// tag with no closing one reads as inside the boundary — and measuring the
// budget without the frame let a framed block exceed it. Content full of the
// delimiter token is the hard case: the frame neutralizes each one, and
// lengthens the content as it does.

import { describe, it, expect } from 'vitest';
import { TOOL_RESULT_MODEL_CHARS } from '@nodal-agents/shared';
import { framedToolResult, raisedErrorBlock } from '../../job/execute.ts';

const OPEN = '<untrusted_tool_result>';
const CLOSE = '</untrusted_tool_result>';

describe('a third party’s result is cut, then framed, within the budget @cap:connecter-un-service/moteur', () => {
  it('content full of the delimiter token: the frame still closes, within the budget, the cut said', () => {
    const framed = framedToolResult('web_search', 'untrusted_tool_result '.repeat(1_200));

    expect(framed.startsWith(OPEN)).toBe(true);
    expect(framed.endsWith(CLOSE)).toBe(true);
    expect(framed.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(framed).toContain('[... truncated:');
  });

  it('a long page from a connector: within the budget, the frame closed', () => {
    const framed = framedToolResult('gmail_read_message', 'A long mail. '.repeat(3_000));

    expect(framed.endsWith(CLOSE)).toBe(true);
    expect(framed.length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
  });

  it('a result under the budget is framed whole, never cut', () => {
    const framed = framedToolResult('file_read', 'A short file with untrusted_tool_result in it.');

    expect(framed).toContain('A short file with untrusted_tool_result_ in it.');
    expect(framed).not.toContain('truncated');
  });

  it('a long failure the tool raised: the whole `{ error }` block, escaping included, within the budget', () => {
    const block = raisedErrorBlock(
      'firecrawl_scrape',
      'Upstream said "no" — untrusted_tool_result\n'.repeat(1_000),
    );

    expect(JSON.stringify(block).length).toBeLessThanOrEqual(TOOL_RESULT_MODEL_CHARS);
    expect(String(block.error).endsWith(CLOSE)).toBe(true);
  });
});
