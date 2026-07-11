// chain-counters.test.ts — ChainCounters unit tests
// Pure logic, no DB needed.

import { describe, it, expect } from 'vitest';
import {
  ChainCounters,
  DEFAULT_LIMITS,
  NON_PROGRESS_SAME_TOOL_NUDGE_AT,
  NON_PROGRESS_SAME_TOOL_FAIL_AT,
  NON_PROGRESS_ERROR_STREAK_NUDGE_AT,
  NON_PROGRESS_ERROR_STREAK_FAIL_AT,
  recordSameToolCall,
  recordToolOutcome,
  INITIAL_SAME_TOOL_STREAK_STATE,
  INITIAL_ERROR_STREAK_STATE,
} from '../chain-counters';
import {
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
} from '../errors';

describe('ChainCounters', () => {
  describe('DEFAULT_LIMITS', () => {
    it('has maxChains=15, maxToolCallsPerTurn=50, maxDelegationDepth=3, maxTurns=50', () => {
      // maxChains relaxed from 5 → 15 on 2026-05-19 — sequential-delegation
      // workflows (fill N pages, send N emails, …) need ~N chains and 5 was
      // killing legitimate jobs. Anti-runaway protection is provided by
      // failed_delegations_count cap (1) + delegation_depth cap (3).
      expect(DEFAULT_LIMITS.maxChains).toBe(15);
      expect(DEFAULT_LIMITS.maxToolCallsPerTurn).toBe(50);
      expect(DEFAULT_LIMITS.maxDelegationDepth).toBe(3);
      expect(DEFAULT_LIMITS.maxTurns).toBe(50);
    });
  });

  describe('bumpChain()', () => {
    it('starts at 0', () => {
      const c = new ChainCounters();
      expect(c.chains).toBe(0);
    });

    it('increments on each call', () => {
      const c = new ChainCounters();
      c.bumpChain();
      expect(c.chains).toBe(1);
      c.bumpChain();
      expect(c.chains).toBe(2);
    });

    it('throws ChainLimitExceededError at maxChains', () => {
      const c = new ChainCounters({ ...DEFAULT_LIMITS, maxChains: 5 });
      // bump 4 times fine (0→1, 1→2, 2→3, 3→4)
      c.bumpChain();
      c.bumpChain();
      c.bumpChain();
      c.bumpChain();
      // 5th bump: chains becomes 5 >= maxChains(5) → throws
      expect(() => c.bumpChain()).toThrow(ChainLimitExceededError);
    });

    it('error carries current and limit', () => {
      const c = new ChainCounters({
        maxChains: 2,
        maxToolCallsPerTurn: 50,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpChain(); // 1
      try {
        c.bumpChain(); // 2 >= 2 → throws
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ChainLimitExceededError);
        const e = err as ChainLimitExceededError;
        expect(e.code).toBe('chain_limit_exceeded');
        expect(e.current).toBe(2);
        expect(e.limit).toBe(2);
      }
    });
  });

  describe('bumpChainOnApprovalResume()', () => {
    it('is a no-op — chain_count does not increment', () => {
      const c = new ChainCounters();
      c.bumpChain();
      expect(c.chains).toBe(1);

      // Simulating resume from awaiting_approval: must NOT increment
      c.bumpChainOnApprovalResume();
      expect(c.chains).toBe(1); // unchanged

      c.bumpChainOnApprovalResume();
      expect(c.chains).toBe(1); // still unchanged
    });

    it('can be called many times without ever throwing', () => {
      const c = new ChainCounters({
        maxChains: 1,
        maxToolCallsPerTurn: 50,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      // Even with very tight limit, approval-resume never throws
      for (let i = 0; i < 100; i++) {
        expect(() => c.bumpChainOnApprovalResume()).not.toThrow();
      }
    });

    it('approval-resume does not count toward chain limit', () => {
      const c = new ChainCounters({
        maxChains: 3,
        maxToolCallsPerTurn: 50,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });

      // Simulate: chain 1 → awaiting_approval → resume (no bump) → chain 2
      c.bumpChain(); // chain 1
      c.bumpChainOnApprovalResume(); // approval resume — NO bump
      c.bumpChain(); // chain 2
      c.bumpChainOnApprovalResume(); // another approval pause — NO bump
      expect(c.chains).toBe(2); // only real chains counted

      // chain 3 → throws (2 + 1 = 3 >= 3)
      expect(() => c.bumpChain()).toThrow(ChainLimitExceededError);
    });
  });

  describe('bumpToolCall()', () => {
    it('starts at 0', () => {
      const c = new ChainCounters();
      expect(c.toolCallsThisTurn).toBe(0);
    });

    it('throws ToolCallLimitExceededError when exceeding maxToolCallsPerTurn', () => {
      const c = new ChainCounters({
        maxChains: 5,
        maxToolCallsPerTurn: 3,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpToolCall(); // 1
      c.bumpToolCall(); // 2
      c.bumpToolCall(); // 3
      // 4th call: 4 > 3 → throws
      expect(() => c.bumpToolCall()).toThrow(ToolCallLimitExceededError);
    });

    it('error carries current and limit', () => {
      const c = new ChainCounters({
        maxChains: 5,
        maxToolCallsPerTurn: 2,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpToolCall();
      c.bumpToolCall();
      try {
        c.bumpToolCall(); // 3 > 2 → throws
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolCallLimitExceededError);
        const e = err as ToolCallLimitExceededError;
        expect(e.code).toBe('tool_call_limit_exceeded');
        expect(e.current).toBe(3);
        expect(e.limit).toBe(2);
      }
    });

    it('resets on resetTurnToolCalls()', () => {
      const c = new ChainCounters({
        maxChains: 5,
        maxToolCallsPerTurn: 2,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpToolCall();
      c.bumpToolCall();
      c.resetTurnToolCalls();
      expect(c.toolCallsThisTurn).toBe(0);
      // Can bump again after reset
      c.bumpToolCall();
      expect(c.toolCallsThisTurn).toBe(1);
    });
  });

  describe('bumpDelegationDepth()', () => {
    it('starts at 0', () => {
      const c = new ChainCounters();
      expect(c.delegationDepth).toBe(0);
    });

    it('increments on each call', () => {
      const c = new ChainCounters();
      c.bumpDelegationDepth();
      expect(c.delegationDepth).toBe(1);
      c.bumpDelegationDepth();
      expect(c.delegationDepth).toBe(2);
    });

    it('throws DelegationDepthExceededError at maxDelegationDepth', () => {
      const c = new ChainCounters({
        maxChains: 5,
        maxToolCallsPerTurn: 50,
        maxDelegationDepth: 3,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpDelegationDepth(); // 1
      c.bumpDelegationDepth(); // 2
      c.bumpDelegationDepth(); // 3
      // 4th: 4 > 3 → throws
      expect(() => c.bumpDelegationDepth()).toThrow(DelegationDepthExceededError);
    });

    it('error carries current and limit', () => {
      const c = new ChainCounters({
        maxChains: 5,
        maxToolCallsPerTurn: 50,
        maxDelegationDepth: 2,
        maxTurns: 50,
        maxConsecutiveDeliveryTurns: 3,
        maxTotalTokensPerJob: 1_500_000,
        maxNoProgressRepeats: 12,
        noDeliveryNudgeAt: 12,
        sameToolStreakNudgeAt: 8,
        maxNoDeliveryNudges: 2,
        nudgeSpacing: 3,
        noDeliveryFailAt: 20,
        maxCostPerJobUsd: 2.0,
      });
      c.bumpDelegationDepth();
      c.bumpDelegationDepth();
      try {
        c.bumpDelegationDepth(); // 3 > 2 → throws
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DelegationDepthExceededError);
        const e = err as DelegationDepthExceededError;
        expect(e.code).toBe('delegation_depth_exceeded');
        expect(e.current).toBe(3);
        expect(e.limit).toBe(2);
      }
    });
  });

  describe('DEFAULT_LIMITS enforcement (invariant 8)', () => {
    it('throws at exactly 15 chains (invariant 8)', () => {
      const c = new ChainCounters(); // uses DEFAULT_LIMITS
      for (let i = 0; i < 14; i++) c.bumpChain(); // 1..14 — fine
      expect(() => c.bumpChain()).toThrow(ChainLimitExceededError); // 15 >= 15
    });

    it('throws at 51st tool call (invariant 8)', () => {
      const c = new ChainCounters();
      for (let i = 0; i < 50; i++) c.bumpToolCall(); // 1..50 — fine
      expect(() => c.bumpToolCall()).toThrow(ToolCallLimitExceededError); // 51 > 50
    });

    it('throws at 4th delegation depth (invariant 8)', () => {
      const c = new ChainCounters();
      c.bumpDelegationDepth(); // 1
      c.bumpDelegationDepth(); // 2
      c.bumpDelegationDepth(); // 3
      expect(() => c.bumpDelegationDepth()).toThrow(DelegationDepthExceededError); // 4 > 3
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips through serialization', () => {
      const c = new ChainCounters();
      c.bumpChain();
      c.bumpChain();
      c.bumpToolCall();
      c.bumpDelegationDepth();

      const snap = c.toJSON();
      expect(snap.chains).toBe(2);
      expect(snap.toolCallsThisTurn).toBe(1);
      expect(snap.delegationDepth).toBe(1);

      const restored = ChainCounters.fromJSON(snap);
      expect(restored.chains).toBe(2);
      expect(restored.toolCallsThisTurn).toBe(1);
      expect(restored.delegationDepth).toBe(1);
    });
  });
});

// ─── Guard 1f — non-progress detector (pure reducers) ────────────────────────
// Incident 2026-07-11: a worker looped 38 turns of `run_command` probing for a
// ComfyUI install; watcher agents retried attach_mcp/create_mcp after failures
// instead of reporting. See chain-counters.ts for the full write-up.

describe('recordSameToolCall (S1)', () => {
  it('has thresholds 12 (nudge) / 24 (fail)', () => {
    expect(NON_PROGRESS_SAME_TOOL_NUDGE_AT).toBe(12);
    expect(NON_PROGRESS_SAME_TOOL_FAIL_AT).toBe(24);
  });

  it('starts a streak of 1 on the first call', () => {
    const { state, signal } = recordSameToolCall(INITIAL_SAME_TOOL_STREAK_STATE, 'file_list');
    expect(state).toEqual({ toolName: 'file_list', streak: 1, nudged: false });
    expect(signal).toBe('none');
  });

  it('extends the streak on repeated calls to the same tool', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    for (let i = 0; i < 5; i++) {
      ({ state } = recordSameToolCall(state, 'file_list'));
    }
    expect(state.streak).toBe(5);
  });

  it('resets the streak to 1 when a different tool is called', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    for (let i = 0; i < 5; i++) {
      ({ state } = recordSameToolCall(state, 'file_list'));
    }
    ({ state } = recordSameToolCall(state, 'file_read'));
    expect(state).toEqual({ toolName: 'file_read', streak: 1, nudged: false });
  });

  it('signals "nudge" exactly once when the streak reaches nudgeAt=12, then "none" until failAt', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    let nudgeCount = 0;
    for (let i = 0; i < 20; i++) {
      const r = recordSameToolCall(state, 'run_command');
      state = r.state;
      if (r.signal === 'nudge') nudgeCount++;
    }
    expect(state.streak).toBe(20);
    expect(nudgeCount).toBe(1); // fired once at streak 12, not again through 20
  });

  it('signals "fail" at streak 24', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    let lastSignal: 'none' | 'nudge' | 'fail' = 'none';
    for (let i = 0; i < 24; i++) {
      const r = recordSameToolCall(state, 'run_command');
      state = r.state;
      lastSignal = r.signal;
    }
    expect(state.streak).toBe(24);
    expect(lastSignal).toBe('fail');
  });

  it('a new streak after a reset gets its own fresh nudge', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    for (let i = 0; i < 12; i++) ({ state } = recordSameToolCall(state, 'a'));
    expect(state.nudged).toBe(true);
    // Different tool breaks the streak — nudged resets for the new streak.
    ({ state } = recordSameToolCall(state, 'b'));
    expect(state.nudged).toBe(false);
    let secondNudgeFired = false;
    for (let i = 0; i < 11; i++) {
      const r = recordSameToolCall(state, 'b');
      state = r.state;
      if (r.signal === 'nudge') secondNudgeFired = true;
    }
    expect(state.streak).toBe(12);
    expect(secondNudgeFired).toBe(true);
  });

  it('exempts return_result and telegram_send_message — transparent to the streak', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    for (let i = 0; i < 6; i++) ({ state } = recordSameToolCall(state, 'file_list'));
    expect(state.streak).toBe(6);
    // 5 exempt calls in a row — must not touch the running streak.
    for (const exempt of ['return_result', 'telegram_send_message', 'return_result']) {
      const r = recordSameToolCall(state, exempt);
      expect(r.signal).toBe('none');
      state = r.state;
    }
    expect(state).toEqual({ toolName: 'file_list', streak: 6, nudged: false });
    // The file_list streak resumes exactly where it left off.
    ({ state } = recordSameToolCall(state, 'file_list'));
    expect(state.streak).toBe(7);
  });

  it('honors custom thresholds (not just the defaults)', () => {
    let state = INITIAL_SAME_TOOL_STREAK_STATE;
    let signal: 'none' | 'nudge' | 'fail' = 'none';
    for (let i = 0; i < 3; i++) {
      const r = recordSameToolCall(state, 'x', 2, 3);
      state = r.state;
      signal = r.signal;
    }
    expect(state.streak).toBe(3);
    expect(signal).toBe('fail');
  });
});

describe('recordToolOutcome (S2)', () => {
  it('has thresholds 5 (nudge) / 10 (fail)', () => {
    expect(NON_PROGRESS_ERROR_STREAK_NUDGE_AT).toBe(5);
    expect(NON_PROGRESS_ERROR_STREAK_FAIL_AT).toBe(10);
  });

  it('a success is a no-op on the initial (zero) state', () => {
    const { state, signal } = recordToolOutcome(INITIAL_ERROR_STREAK_STATE, false);
    expect(state).toEqual(INITIAL_ERROR_STREAK_STATE);
    expect(signal).toBe('none');
  });

  it('extends the streak on consecutive failures', () => {
    let state = INITIAL_ERROR_STREAK_STATE;
    for (let i = 0; i < 4; i++) {
      ({ state } = recordToolOutcome(state, true));
    }
    expect(state.streak).toBe(4);
  });

  it('signals "nudge" once at streak 5', () => {
    let state = INITIAL_ERROR_STREAK_STATE;
    let nudgeCount = 0;
    for (let i = 0; i < 9; i++) {
      const r = recordToolOutcome(state, true);
      state = r.state;
      if (r.signal === 'nudge') nudgeCount++;
    }
    expect(state.streak).toBe(9);
    expect(nudgeCount).toBe(1);
  });

  it('signals "fail" at streak 10', () => {
    let state = INITIAL_ERROR_STREAK_STATE;
    let lastSignal: 'none' | 'nudge' | 'fail' = 'none';
    for (let i = 0; i < 10; i++) {
      const r = recordToolOutcome(state, true);
      state = r.state;
      lastSignal = r.signal;
    }
    expect(state.streak).toBe(10);
    expect(lastSignal).toBe('fail');
  });

  it('a success after 4 failures resets the streak to 0 (no nudge at the 5th call)', () => {
    let state = INITIAL_ERROR_STREAK_STATE;
    for (let i = 0; i < 4; i++) ({ state } = recordToolOutcome(state, true));
    expect(state.streak).toBe(4);
    const r = recordToolOutcome(state, false);
    expect(r.signal).toBe('none');
    expect(r.state).toEqual(INITIAL_ERROR_STREAK_STATE);
  });

  it('applies uniformly regardless of tool name — S2 has no exemption', () => {
    // The reducer doesn't even take a tool name — confirms by construction
    // that return_result / telegram_send_message failures are NOT exempt.
    let state = INITIAL_ERROR_STREAK_STATE;
    for (let i = 0; i < 5; i++) ({ state } = recordToolOutcome(state, true));
    expect(state.streak).toBe(5);
  });

  it('honors custom thresholds (not just the defaults)', () => {
    let state = INITIAL_ERROR_STREAK_STATE;
    let signal: 'none' | 'nudge' | 'fail' = 'none';
    for (let i = 0; i < 3; i++) {
      const r = recordToolOutcome(state, true, 2, 3);
      state = r.state;
      signal = r.signal;
    }
    expect(state.streak).toBe(3);
    expect(signal).toBe('fail');
  });
});
