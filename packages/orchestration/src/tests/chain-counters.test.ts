// chain-counters.test.ts — ChainCounters unit tests
// Pure logic, no DB needed.

import { describe, it, expect } from 'vitest';
import {
  ChainCounters,
  assertTurnToolCallBudget,
  DEFAULT_LIMITS,
  NON_PROGRESS_ERROR_STREAK_NUDGE_AT,
  NON_PROGRESS_ERROR_STREAK_FAIL_AT,
  recordToolOutcome,
  INITIAL_ERROR_STREAK_STATE,
  remainingDelegationResumes,
  delegationResumeLimitMessage,
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

  describe('admitTurn() — a turn is admitted or refused whole (#564)', () => {
    const limits = {
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
      maxCostPerJobUsd: 2.0,
    };

    it('starts at 0', () => {
      const c = new ChainCounters();
      expect(c.toolCallsThisTurn).toBe(0);
    });

    it('admits a turn at exactly the budget', () => {
      const c = new ChainCounters(limits);
      c.admitTurn(3);
      expect(c.toolCallsThisTurn).toBe(3);
    });

    it('refuses a turn over the budget, with its size and the limit', () => {
      const c = new ChainCounters(limits);
      try {
        c.admitTurn(307);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolCallLimitExceededError);
        const e = err as ToolCallLimitExceededError;
        expect(e.code).toBe('tool_call_limit_exceeded');
        expect(e.current).toBe(307);
        expect(e.limit).toBe(3);
        expect(e.message).toBe('tool_call_limit_exceeded: 307 > 3');
      }
    });

    it('each turn is measured on its own: a small turn after a large admitted one passes', () => {
      const c = new ChainCounters(limits);
      c.admitTurn(3);
      c.admitTurn(1);
      expect(c.toolCallsThisTurn).toBe(1);
    });

    it('the production budget is 50: 50 admitted, 51 refused', () => {
      expect(() => assertTurnToolCallBudget(50)).not.toThrow();
      expect(() => assertTurnToolCallBudget(51)).toThrow(ToolCallLimitExceededError);
      expect(() => new ChainCounters().admitTurn(51)).toThrow(ToolCallLimitExceededError);
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

    it('refuses a turn of 51 tool calls, admits one of 50 (invariant 8)', () => {
      const c = new ChainCounters();
      c.admitTurn(50); // fine
      expect(() => c.admitTurn(51)).toThrow(ToolCallLimitExceededError); // 51 > 50
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
      c.admitTurn(1);
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

// S1 (the same tool NAME called N times in a row, any inputs, success
// included) is gone: it killed legitimate batch work. Its absence is proved on
// the real job loop (apps/runner/src/tests/job/execute.test.ts, "Guard 1f").

describe('remainingDelegationResumes / delegationResumeLimitMessage @cap:organiser-equipe/moteur', () => {
  it('leaves room for a delegation while its resume stays under maxChains', () => {
    // maxChains = 15: a job is refused at entry once chain_count reaches 15,
    // so a delegation is admitted while chain_count + 1 < 15.
    expect(remainingDelegationResumes(0)).toBe(14);
    expect(remainingDelegationResumes(13)).toBe(1);
    expect(remainingDelegationResumes(14)).toBe(0);
    expect(remainingDelegationResumes(40)).toBe(0);
  });

  it('follows the limits it is given, not only the defaults', () => {
    const limits = { ...DEFAULT_LIMITS, maxChains: 3 };
    expect(remainingDelegationResumes(1, limits)).toBe(1);
    expect(remainingDelegationResumes(2, limits)).toBe(0);
  });

  it('names the cap and the count, and gives no instruction to call again', () => {
    const msg = delegationResumeLimitMessage(14);
    expect(msg).toMatch(/^delegation_limit_reached: /);
    expect(msg).toContain('resumed 14 times');
    expect(msg).toContain('at most 14 times');
    expect(msg).not.toMatch(/call it again|try again|retry/i);
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
