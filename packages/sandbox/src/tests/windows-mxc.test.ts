// windows-mxc.test.ts — le backend MXC, sondé et démarré pour de vrai.

import { describe, it, expect } from 'vitest';
import { mxcBackend, MXC_BACKEND_NAME } from '../windows-mxc';
import { mxcErrorText } from '../mxc-broker';
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
    await expect(backend.openContainer([], {})).rejects.toBeInstanceOf(SandboxStartError);
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

describe('mxcBackend — boucle locale de l’hôte (tous systèmes)', () => {
  it('base-container sans la capacité ingressHostLoopbackAllow : indisponible, la capacité nommée, aucune commande lancée', async () => {
    let spawned = 0;
    const sdk = {
      getPlatformSupport: () => ({
        isSupported: true,
        reason: '',
        availableMethods: ['processcontainer'],
        isolationTier: 'base-container',
      }),
      getAvailableBackends: () => [
        {
          backend: 'processcontainer',
          tier: 'base-container',
          capabilities: ['captureDenials'],
          warnings: ['host loopback not supported on this build'],
        },
      ],
      spawn: () => {
        spawned++;
        throw new Error('must not be called');
      },
    };
    const backend = mxcBackend(() => Promise.resolve(sdk as never));
    expect(await backend.probe()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_PLATFORM_UNSUPPORTED',
      reason:
        'processcontainer lacks ingressHostLoopbackAllow | host loopback not supported on this build',
    });
    expect(spawned).toBe(0);
  });
});

describe('mxcErrorText — une erreur du SDK dit quoi ET que faire (tous systèmes)', () => {
  it('la remédiation de MXC suit le message ; sans remédiation, `code: message` seul', () => {
    // Les champs d'un `MxcError` levé par le SDK 1.0.0 sur un Node trop ancien
    // (dist/bindings/streaming.js, ensureSupportedNodeVersion).
    expect(
      mxcErrorText({
        code: 'backend_unavailable',
        message:
          'native stdio on Windows requires Node.js 24.21.0 or newer within Node.js 24, or Node.js 26.8.0 or newer; current version is 26.4.0',
        remediation:
          'Use Node.js 24.21.0 or newer within Node.js 24, or Node.js 26.8.0 or newer on Windows.',
      }),
    ).toBe(
      'backend_unavailable: native stdio on Windows requires Node.js 24.21.0 or newer within Node.js 24, or Node.js 26.8.0 or newer; current version is 26.4.0. Use Node.js 24.21.0 or newer within Node.js 24, or Node.js 26.8.0 or newer on Windows.',
    );
    expect(mxcErrorText({ code: 'policy_validation', message: 'missing LOCALAPPDATA' })).toBe(
      'policy_validation: missing LOCALAPPDATA',
    );
    expect(mxcErrorText(new Error('plain'))).toBe('plain');
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

    it('un conteneur que MXC refuse d’ouvrir lève SandboxStartError avec SA raison (ici : LOCALAPPDATA absent)', async () => {
      const env = { SYSTEMROOT: process.env['SYSTEMROOT'], PATH: process.env['PATH'] };
      const error = await mxcBackend()
        .openContainer([], env)
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

// Le Node de CE processus est-il dans la plage que MXC exige sous Windows
// (`>=24.21.0 <25 || >=26.8.0`, @microsoft/mxc-sdk 1.0.0
// dist/bindings/native-stdio.js) ? Les engines de Nodal disent `>=24` : un
// utilisateur sous 24.0 à 24.20, ou sous 26.0 à 26.7, est un cas réel.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const nodeInMxcRange = (major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major > 26;

describe.runIf(isWindows && tier === 'base-container' && !nodeInMxcRange)(
  'mxcBackend — le vrai MXC sous un Node trop ancien pour lui (Windows, palier base-container)',
  () => {
    it('la sonde dit SANDBOX_SELF_TEST_FAILED, et la raison nomme le Node courant, les versions requises, et quoi faire', async () => {
      const status = await mxcBackend().probe();
      expect(status.state).toBe('unavailable');
      if (status.state !== 'unavailable') return;
      expect(status.code).toBe('SANDBOX_SELF_TEST_FAILED');
      expect(status.reason).toContain(`current version is ${process.versions.node}`);
      expect(status.reason).toMatch(/requires Node\.js 24\.21\.0 .*26\.8\.0/);
      expect(status.reason).toMatch(
        /\. Use Node\.js 24\.21\.0 or newer within Node\.js 24, or Node\.js 26\.8\.0 or newer on Windows\.$/,
      );
    });
  },
);
