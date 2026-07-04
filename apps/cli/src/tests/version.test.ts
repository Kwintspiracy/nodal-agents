// version.test.ts — pure comparator behind the "update available" notice
// (up.ts 7.5). Guards against suggesting a downgrade when the registry's
// `latest` dist-tag is at/behind the installed version.

import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../lib/version.ts';

describe('isNewerVersion', () => {
  it('returns false when candidate is older (patch)', () => {
    expect(isNewerVersion('0.6.8', '0.7.0')).toBe(false);
  });

  it('returns true when candidate is newer (major)', () => {
    expect(isNewerVersion('0.8.0', '0.7.0')).toBe(true);
  });

  it('returns true when candidate is newer (patch)', () => {
    expect(isNewerVersion('0.7.1', '0.7.0')).toBe(true);
  });

  it('returns false on exact equality', () => {
    expect(isNewerVersion('0.7.0', '0.7.0')).toBe(false);
  });

  it('returns true when candidate is newer (minor)', () => {
    expect(isNewerVersion('0.8.0', '0.7.9')).toBe(true);
  });

  it('returns false when candidate is older (minor)', () => {
    expect(isNewerVersion('0.7.0', '0.8.0')).toBe(false);
  });

  it('ignores a pre-release suffix and treats equal numeric triples as not newer', () => {
    expect(isNewerVersion('0.7.0-beta.1', '0.7.0')).toBe(false);
  });

  it('returns false when either string is unparseable', () => {
    expect(isNewerVersion('not-a-version', '0.7.0')).toBe(false);
    expect(isNewerVersion('0.7.0', 'not-a-version')).toBe(false);
  });
});
