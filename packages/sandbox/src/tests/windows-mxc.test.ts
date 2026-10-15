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

describe('mxcBackend — boucle locale, politique required (tous systèmes)', () => {
  it('base-container SANS ingressHostLoopbackAllow : indisponible, SANDBOX_HOST_LOOPBACK_UNSUPPORTED, aucune commande lancée', async () => {
    let spawned = 0;
    const sdk = {
      getPlatformSupport: () => ({
        isSupported: true,
        reason: '',
        availableMethods: ['processcontainer'],
        isolationTier: 'base-container',
      }),
      // Ce que windows-11-arm (26200.9457) rend : pas la capacité.
      getAvailableBackends: () => [
        { backend: 'processcontainer', tier: 'base-container', capabilities: [], warnings: [] },
      ],
      spawn: () => {
        spawned++;
        throw new Error('must not be called');
      },
    };
    const backend = mxcBackend(() => Promise.resolve(sdk as never), 'required');
    expect(await backend.probe()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_HOST_LOOPBACK_UNSUPPORTED',
      reason:
        'base-container without the MXC capability ingressHostLoopbackAllow: a confined command cannot reach a service of this machine on 127.0.0.1',
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
    // Ce que MXC dit de CE build (26200.9711 : la capacité ; 26200.9457,
    // l'image windows-11-arm : pas la capacité). Chaque branche est prouvée
    // sur la machine qui la porte, sous les deux valeurs de la politique.
    const loopbackCapability = async (): Promise<boolean> =>
      (await import('@microsoft/mxc-sdk/v1'))
        .getAvailableBackends()
        .some(
          (b) =>
            b.backend === 'processcontainer' && b.capabilities.includes('ingressHostLoopbackAllow'),
        );

    it('politique par défaut (closed) : `available`, la boucle locale fermée dite dans `limits`, avec ou sans la capacité', async () => {
      const status = await mxcBackend().probe();
      expect(status, JSON.stringify(status)).toEqual({
        state: 'available',
        backend: MXC_BACKEND_NAME,
        limits: [
          'SANDBOX_HOST_LOOPBACK_CLOSED: host loopback not opened (policy closed): a confined command cannot reach a service of this machine on 127.0.0.1, and on some Windows builds not even a server started by an earlier command of its job',
        ],
      });
    });

    it('politique required : `available` avec la capacité ; sans elle, SANDBOX_HOST_LOOPBACK_UNSUPPORTED', async () => {
      const status = await mxcBackend(undefined, 'required').probe();
      expect(status, JSON.stringify(status)).toEqual(
        (await loopbackCapability())
          ? { state: 'available', backend: MXC_BACKEND_NAME }
          : {
              state: 'unavailable',
              code: 'SANDBOX_HOST_LOOPBACK_UNSUPPORTED',
              reason:
                'base-container without the MXC capability ingressHostLoopbackAllow: a confined command cannot reach a service of this machine on 127.0.0.1',
            },
      );
    });

    it('politique when-available : `available` partout ; la boucle locale fermée est dite dans `limits`, et seulement si elle l’est', async () => {
      const status = await mxcBackend(undefined, 'when-available').probe();
      expect(status, JSON.stringify(status)).toEqual(
        (await loopbackCapability())
          ? { state: 'available', backend: MXC_BACKEND_NAME }
          : {
              state: 'available',
              backend: MXC_BACKEND_NAME,
              limits: [
                'SANDBOX_HOST_LOOPBACK_UNSUPPORTED: base-container without the MXC capability ingressHostLoopbackAllow: a confined command cannot reach a service of this machine on 127.0.0.1',
              ],
            },
      );
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
  'mxcBackend — le Node de l’utilisateur est trop ancien pour le SDK (Windows, palier base-container)',
  () => {
    // D5 : le courtier tourne sur le Node DÉDIÉ que Nodal télécharge, pas sur
    // celui de l'utilisateur. Donc le bac à sable est DISPONIBLE même ici, où
    // `process.versions.node` est trop ancien pour les flux natifs du SDK.
    it('le bac à sable est `available` via le Node dédié du courtier', async () => {
      const status = await mxcBackend().probe();
      expect(status, JSON.stringify(status)).toMatchObject({
        state: 'available',
        backend: MXC_BACKEND_NAME,
      });
    }, 120_000);

    // Et la preuve que c'est bien le Node dédié qui sauve : forcé sur le Node
    // de l'utilisateur, le même backend échoue, en nommant les versions.
    it('forcé sur le Node de l’utilisateur, il échoue et nomme les versions requises', async () => {
      const status = await mxcBackend(undefined, undefined, process.execPath).probe();
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
