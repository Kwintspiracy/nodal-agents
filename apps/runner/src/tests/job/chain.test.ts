// chain.test.ts — chain count bumps, max enforced

import { describe, it, expect } from 'vitest';
import { checkChainLimit, ChainLimitError, MAX_CHAINS } from '../../job/chain.ts';

describe('checkChainLimit', () => {
  it('does not throw when chainCount is below max', () => {
    for (let i = 0; i < MAX_CHAINS; i++) {
      expect(() => checkChainLimit(i)).not.toThrow();
    }
  });

  it('throws ChainLimitError when chainCount equals MAX_CHAINS', () => {
    expect(() => checkChainLimit(MAX_CHAINS)).toThrow(ChainLimitError);
  });

  it('throws ChainLimitError when chainCount exceeds MAX_CHAINS', () => {
    expect(() => checkChainLimit(MAX_CHAINS + 1)).toThrow(ChainLimitError);
  });

  it('ChainLimitError carries the right code and values', () => {
    try {
      checkChainLimit(MAX_CHAINS);
    } catch (err) {
      expect(err).toBeInstanceOf(ChainLimitError);
      const e = err as ChainLimitError;
      expect(e.code).toBe('chain_limit_exceeded');
      expect(e.current).toBe(MAX_CHAINS);
      expect(e.limit).toBe(MAX_CHAINS);
    }
  });

  it('MAX_CHAINS is 5 (matching @nodal-agents/orchestration DEFAULT_LIMITS)', () => {
    expect(MAX_CHAINS).toBe(5);
  });
});

describe('ChainLimitError', () => {
  it('has no user-facing message — only a code', () => {
    const err = new ChainLimitError(5, 5);
    // Message must be machine-readable, not human-facing
    expect(err.message).toMatch(/chain_limit_exceeded/);
    // Must NOT contain user-facing copy (invariant 2)
    expect(err.message).not.toMatch(/sorry/i);
    expect(err.message).not.toMatch(/couldn't/i);
    expect(err.message).not.toMatch(/try again/i);
  });
});
