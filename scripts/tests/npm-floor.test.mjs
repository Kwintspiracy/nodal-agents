// npm-floor.test.mjs — the comparison behind the pack-smoke npm floor (11.6.0,
// measured 16/10/2026: npm 11.5.2 crashes on install, 11.6.0 installs).
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { compareVersions } from '../lib/npm-floor.mjs';

describe('compareVersions', () => {
  it('orders the npm versions measured around the floor', () => {
    const measured = ['12.2.0', '11.5.2', '10.9.9', '11.6.0', '11.19.1', '11.3.0'];
    expect([...measured].sort(compareVersions)).toEqual([
      '10.9.9',
      '11.3.0',
      '11.5.2',
      '11.6.0',
      '11.19.1',
      '12.2.0',
    ]);
  });

  it('compares numerically, not as text (11.19 is above 11.6)', () => {
    expect(compareVersions('11.19.1', '11.6.0')).toBeGreaterThan(0);
    expect(compareVersions('11.5.2', '11.6.0')).toBeLessThan(0);
    expect(compareVersions('11.6.0', '11.6.0')).toBe(0);
  });

  it('fails loud on something that is not a version', () => {
    expect(() => compareVersions('', '11.6.0')).toThrow(/not a version/);
    expect(() => compareVersions('npm ERR!', '11.6.0')).toThrow(/not a version/);
  });
});
