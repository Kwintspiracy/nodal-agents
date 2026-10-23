// mxc-tier.test.ts — un palier MXC illisible fait échouer, il ne se saute pas.
//
// Mutation vérifiée (annulée ensuite) : `unsupportedByTier` qui rend `true` pour
// `isolationTier=unknown` (l'ancien « palier autre que base-container ») →
// « an unreadable tier fails loud » rouge.

import { describe, it, expect } from 'vitest';
import { unreadableTierError, unsupportedByTier } from '../mxc-tier';

describe('unsupportedByTier: a tier the probe could not read fails loud, it is never "another tier"', () => {
  const unsupported = (reason: string) => ({
    state: 'unavailable',
    code: 'SANDBOX_PLATFORM_UNSUPPORTED',
    reason,
  });

  it('a real tier that is not base-container: unsupported, the battery skips by name', () => {
    expect(unsupportedByTier(unsupported('isolationTier=appcontainer-dacl | w'))).toBe(true);
    expect(unsupportedByTier(unsupported('isolationTier=appcontainer-bfs'))).toBe(true);
  });

  it('an unreadable tier fails loud, with what the probe said', () => {
    expect(() => unsupportedByTier(unsupported('isolationTier=unknown'))).toThrow(
      'MXC SDK probe could not read the isolation tier: the sandbox probe says "isolationTier=unknown"; the sandbox proofs cannot run',
    );
    expect(() => unsupportedByTier(unsupported('isolationTier=unknown | a warning'))).toThrow(
      /could not read the isolation tier/,
    );
  });

  it('an available sandbox, another unavailability, or no status: not a tier question', () => {
    expect(unsupportedByTier({ state: 'available' })).toBe(false);
    expect(
      unsupportedByTier({
        state: 'unavailable',
        code: 'SANDBOX_SELF_TEST_FAILED',
        reason: 'isolationTier=unknown',
      }),
    ).toBe(false);
    expect(unsupportedByTier(undefined)).toBe(false);
  });

  it('a tier whose name merely starts with "unknown" is a tier', () => {
    expect(unsupportedByTier(unsupported('isolationTier=unknown-future-tier'))).toBe(true);
  });

  it('the failure names what it will not prove', () => {
    expect(unreadableTierError('x').message).toBe(
      'MXC SDK probe could not read the isolation tier: x; the sandbox proofs cannot run',
    );
  });
});
