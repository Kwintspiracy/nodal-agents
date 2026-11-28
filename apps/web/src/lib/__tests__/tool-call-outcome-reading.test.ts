// tool-call-outcome-reading.test.ts — the screens read the outcome of a call
// on its row, through the product's one reader (#1184), and give the same
// answer as the runner on the same table.

import { describe, it, expect } from 'vitest';
import { TOOL_CALL_OUTCOMES, callMayHaveActed, readCallOutcome } from '@nodal-agents/shared';
import { callHappened, isRefusedOutcome, stepOutcomeOf } from '../tool-card-payload.ts';
import { isRefusedToolCall } from '../coding-changes.ts';

describe('the screens read the column, and only the column @cap:suivre-execution/ecran', () => {
  it('every outcome of the set, and a row older than the column, map to one state of a step', () => {
    expect([...TOOL_CALL_OUTCOMES, null].map((o) => stepOutcomeOf(o))).toEqual([
      'success',
      'error',
      'unknown',
      'blocked',
      'awaiting_approval',
      'unknown',
    ]);
  });

  it('“did it happen” on the screen is the runner’s reading, value by value', () => {
    for (const o of [...TOOL_CALL_OUTCOMES, null]) {
      const shared = callMayHaveActed(readCallOutcome(o));
      expect(callHappened(stepOutcomeOf(o)), String(o)).toBe(shared);
      expect(isRefusedToolCall(o), String(o)).toBe(!shared);
    }
    expect(isRefusedOutcome('refused')).toBe(true);
    expect(isRefusedOutcome('failed')).toBe(false);
  });

  it('the text of an output decides nothing: an outcome outside the set is said loud', () => {
    expect(() => stepOutcomeOf('{"outcome":"error"}')).toThrow(/TOOL_CALL_OUTCOME_OUT_OF_SET/);
  });
});
