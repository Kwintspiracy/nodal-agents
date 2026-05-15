// hash.test.ts — computeFactHash + normalizeFact

import { describe, it, expect } from 'vitest';
import { computeFactHash, normalizeFact } from '../hash';

describe('normalizeFact', () => {
  it('lowercases', () => {
    expect(normalizeFact('User Is Quentin')).toBe('user is quentin');
  });

  it('trims and collapses internal whitespace', () => {
    expect(normalizeFact('  user   is\tquentin  ')).toBe('user is quentin');
  });
});

describe('computeFactHash', () => {
  it('is deterministic', () => {
    expect(computeFactHash('User is Quentin')).toBe(computeFactHash('User is Quentin'));
  });

  it('ignores casing and whitespace differences', () => {
    expect(computeFactHash('User is Quentin')).toBe(computeFactHash('  user IS   quentin '));
  });

  it('produces different hashes for genuinely different facts', () => {
    expect(computeFactHash('User is Quentin')).not.toBe(computeFactHash('User is Mathilde'));
  });

  it('returns a 64-char hex sha256 digest', () => {
    expect(computeFactHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
