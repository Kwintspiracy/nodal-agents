// windows-mxc.test.ts — le backend MXC, sondé et démarré pour de vrai.

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mxcBackend, MXC_BACKEND_NAME } from '../windows-mxc';
import { SandboxStartError } from '../types';

describe('mxcBackend — SDK absent (tous systèmes)', () => {
  it('la sonde dit SANDBOX_BACKEND_MISSING avec la raison du chargement ; un démarrage est refusé', async () => {
    const backend = mxcBackend(() =>
      Promise.reject(new Error("Cannot find package '@microsoft/mxc-sdk'")),
    );
    expect(await backend.probe()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_BACKEND_MISSING',
      reason: "Cannot find package '@microsoft/mxc-sdk'",
    });
    await expect(
      backend.start({ target: { command: 'exit 0' }, cwd: tmpdir(), env: {}, writableRoots: [] }),
    ).rejects.toBeInstanceOf(SandboxStartError);
  });
});

describe('mxcBackend — palier d’isolation (tous systèmes)', () => {
  it('un palier autre que base-container : indisponible, le palier et les avertissements de MXC cités, aucune commande lancée', async () => {
    let spawned = 0;
    // Ce que le runner Windows Server 2025 de GitHub a répondu le 14/10.
    const warning =
      'BaseContainer tier not selected, and AppContainer + BFS is not compiled into this binary; falling back to AppContainer + DACL';
    const sdk = {
      getPlatformSupport: () => ({
        isSupported: true,
        reason: '',
        availableMethods: ['processcontainer', 'hyperlight'],
        isolationTier: 'appcontainer-dacl',
        isolationWarnings: [warning],
      }),
      spawn: () => {
        spawned++;
        throw new Error('must not be called');
      },
    };
    const backend = mxcBackend(() => Promise.resolve(sdk as never));
    expect(await backend.probe()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_PLATFORM_UNSUPPORTED',
      reason: `isolationTier=appcontainer-dacl | ${warning}`,
    });
    expect(spawned).toBe(0);
  });
});

// Le palier que MXC choisit sur CETTE machine : base-container (Windows 11
// récent) se confine ; les autres se disent indisponibles (voir la sonde).
const isWindows = process.platform === 'win32';
const tier = isWindows
  ? (await import('@microsoft/mxc-sdk/v1')).getPlatformSupport().isolationTier
  : undefined;

describe.runIf(isWindows && tier !== 'base-container')(
  'mxcBackend — le vrai MXC, palier autre que base-container (Windows Server, Windows plus ancien)',
  () => {
    it('la sonde dit SANDBOX_PLATFORM_UNSUPPORTED et cite le palier, sans lancer de commande', async () => {
      const status = await mxcBackend().probe();
      expect(status.state).toBe('unavailable');
      expect(status.state === 'unavailable' && status.code).toBe('SANDBOX_PLATFORM_UNSUPPORTED');
      expect(status.state === 'unavailable' && status.reason).toMatch(
        new RegExp(`^isolationTier=${String(tier)}`),
      );
    });
  },
);

describe.runIf(isWindows && tier === 'base-container')(
  'mxcBackend — le vrai MXC, palier base-container (Windows only: MXC is the Windows backend of #628)',
  () => {
    it('la sonde lance une commande confinée triviale et rend `available`', async () => {
      const status = await mxcBackend().probe();
      expect(status, JSON.stringify(status)).toEqual({
        state: 'available',
        backend: MXC_BACKEND_NAME,
      });
    });

    it('un démarrage que MXC refuse lève SandboxStartError avec SA raison (ici : LOCALAPPDATA absent)', async () => {
      const env = { SYSTEMROOT: process.env['SYSTEMROOT'], PATH: process.env['PATH'] };
      const error = await mxcBackend()
        .start({ target: { command: 'exit 0' }, cwd: tmpdir(), env, writableRoots: [] })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(SandboxStartError);
      expect((error as SandboxStartError).message).toMatch(
        /^SANDBOX_START_FAILED: policy_validation: .*LOCALAPPDATA/,
      );
    });
  },
);
