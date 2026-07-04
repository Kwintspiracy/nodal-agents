import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from '../lib/constant-time.ts';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('my-secret-lan-token', 'my-secret-lan-token')).toBe(true);
  });

  it('returns false for a mismatched value of the same length', () => {
    expect(constantTimeEqual('my-secret-lan-token', 'my-secret-lan-toke0')).toBe(false);
  });

  it('returns false for values of different lengths (no length-mismatch throw)', () => {
    expect(constantTimeEqual('short', 'much-longer-value')).toBe(false);
  });

  it('returns false comparing against an empty string', () => {
    expect(constantTimeEqual('token', '')).toBe(false);
  });

  it('returns true when both sides are empty', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
