// mxc-tier.test.ts — un palier MXC que la sonde du SDK n'a pas pu lire fait
// ÉCHOUER les suites qui en dépendent ; il ne les saute pas, il ne les fait pas
// passer pour « un palier autre que base-container » (revue de #859, passe 2).
//
// Mutation vérifiée (annulée ensuite) : `tierOf` qui rend `undefined` au lieu de
// lever (l'ancien `runIf(tier !== 'base-container')` qui prenait l'inconnu pour un
// autre palier) → « an unreadable tier throws » et « the real SDK … » rouges.

import { describe, it, expect } from 'vitest';
import { forceUnreadableProbe, readMxcTier, tier, tierOf } from './mxc-tier';

describe('tierOf: a SDK answer without a tier throws, with what the SDK said (tous systèmes)', () => {
  it('an answer with a tier gives it', () => {
    expect(tierOf({ isSupported: true, isolationTier: 'base-container' })).toBe('base-container');
    expect(tierOf({ isSupported: true, isolationTier: 'appcontainer-dacl' })).toBe(
      'appcontainer-dacl',
    );
  });

  it('an unreadable tier throws: the proofs that need a container cannot run, and the error says why', () => {
    expect(() => tierOf({ isSupported: true })).toThrow(
      /^MXC SDK probe could not read the isolation tier: isSupported=true, reason="" \(wxc-exec --probe failed or timed out.*\); the sandbox proofs cannot run$/,
    );
    expect(() => tierOf({ isSupported: false, reason: 'Windows too old' })).toThrow(
      /isSupported=false, reason="Windows too old"/,
    );
  });
});

describe.runIf(process.platform === 'win32')(
  'the real SDK whose native probe fails (Windows): the tier is not read, it is an error',
  () => {
    it('the tier of this machine was read when the module loaded', () => {
      expect(tier).toBeDefined();
    });

    it('an unreadable probe throws from readMxcTier, then the real probe comes back', async () => {
      const restore = await forceUnreadableProbe();
      try {
        await expect(readMxcTier()).rejects.toThrow(
          /MXC SDK probe could not read the isolation tier/,
        );
      } finally {
        restore();
      }
      expect(await readMxcTier()).toBe(tier);
    });
  },
);
