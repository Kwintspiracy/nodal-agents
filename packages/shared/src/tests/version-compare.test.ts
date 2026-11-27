// version-compare.test.ts — the one rule for "is this version newer".
//
// Every assertion is an ORDER the rule must return, including the cases a
// triple-only or a string comparison gets wrong.

import { describe, it, expect } from 'vitest';
import { compareVersions, isNewerVersion } from '../version-compare.ts';

describe('compareVersions: semver precedence @cap:installer-et-demarrer/moteur', () => {
  it('orders the numeric triple as numbers, not strings', () => {
    expect(compareVersions('0.8.10', '0.8.9')).toBe(1);
    expect(compareVersions('0.9.9', '0.9.10')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.9.11', '0.9.11')).toBe(0);
  });

  it('puts a release AFTER its own pre-releases', () => {
    expect(compareVersions('0.9.12', '0.9.12-beta.1')).toBe(1);
    expect(compareVersions('0.9.12-beta.1', '0.9.12')).toBe(-1);
    // A pre-release of a later triple is still newer than an earlier release.
    expect(compareVersions('0.9.12-beta.1', '0.9.11')).toBe(1);
  });

  it('orders pre-release identifiers by semver section 11', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1); // numbers, not strings
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1); // shorter prefix first
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1); // numeric before alphanumeric
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.2')).toBe(0);
  });

  it('ignores build metadata and a leading v', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
    expect(compareVersions('v0.9.10', '0.9.10')).toBe(0);
  });

  it('answers null, never a guess, on what is not a version', () => {
    expect(compareVersions('not-a-version', '0.7.0')).toBeNull();
    expect(compareVersions('0.7.0', '')).toBeNull();
    expect(compareVersions('1.2', '1.2.0')).toBeNull();
    expect(compareVersions('0.9.10\nnpm WARN', '0.9.10')).toBeNull();
  });

  it('isNewerVersion is the same rule, strict', () => {
    expect(isNewerVersion('0.9.11', '0.9.10')).toBe(true);
    expect(isNewerVersion('0.9.10', '0.9.11')).toBe(false);
    expect(isNewerVersion('0.9.10', '0.9.10')).toBe(false);
    expect(isNewerVersion('0.9.12', '0.9.12-beta.1')).toBe(true);
    expect(isNewerVersion('garbage', '0.9.10')).toBe(false);
  });
});
