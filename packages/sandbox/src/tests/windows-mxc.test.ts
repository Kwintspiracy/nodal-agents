// windows-mxc.test.ts — le backend MXC, sondé et démarré pour de vrai.

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mxcBackend, MXC_BACKEND_NAME, networkSetup, observedOutcome } from '../windows-mxc';
import type { SandboxStatus } from '../types';
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

describe('observedOutcome — what a probe command did, said as observed (tous systèmes)', () => {
  it('cites the exit code and what the command wrote on stderr', () => {
    expect(observedOutcome({ end: { kind: 'exit', exitCode: 7 }, stderr: 'ETIMEDOUT' })).toBe(
      'exit 7: ETIMEDOUT',
    );
    expect(observedOutcome({ end: { kind: 'exit', exitCode: 8 }, stderr: '' })).toBe('exit 8');
  });

  it('cites the error of the container, or the signal', () => {
    expect(
      observedOutcome({ end: { kind: 'error', message: 'policy_validation: x' }, stderr: '' }),
    ).toBe('policy_validation: x');
    expect(observedOutcome({ end: { kind: 'signal' }, stderr: '' })).toBe('signal');
  });
});

describe('networkSetup — what MXC is told per regime (tous systèmes)', () => {
  // The control listener of the real-MXC test below shares this configuration
  // with the product, so a break here would hide inside both: this is the
  // assertion that sees it.
  it('proxy: the container may reach ONLY the proxy peer, named by url; egress stays denied', () => {
    const setup = networkSetup('proxy', 'http://127.0.0.1:4242');
    expect(setup.network).toEqual({
      egress: { default: 'deny' },
      ingress: { default: 'allow' },
      runtimeConfig: { networkProxy: 'http://127.0.0.1:4242' },
    });
    expect(setup.containment).toEqual({
      type: 'processcontainer',
      config: { network: { allowedProxyPeer: 'CLI' } },
    });
    expect(setup.extraEnv).toEqual({ NODE_USE_ENV_PROXY: '1' });
  });

  it('deny-all: no proxy, no peer, no network', () => {
    const setup = networkSetup('deny-all', null);
    expect(setup.network).toEqual({ egress: { default: 'deny' } });
    expect(setup.containment).toBeUndefined();
    expect(setup.extraEnv).toEqual({});
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
    // Les ports de Nodal que le régime proxy refuse (nodalDeniedEndpoints) sont
    // fournis globalement par le setupFile de test-kit (#628, P2-3).

    // Le proxy côté hôte est-il joignable depuis le conteneur sur CE build ?
    // La capacité `ingressHostLoopbackAllow` ne le dit pas : elle le prédisait
    // sur deux machines mesurées (26200.9711, la machine de Quentin : oui ;
    // 26200.9457, windows-11-arm : non), et une TROISIÈME l'a démentie le
    // 22/10 (windows-11-arm 20261018, 26200.9711 Enterprise arm64 : la capacité
    // est là, le `connect` du conteneur reçoit ETIMEDOUT, le paquet est jeté).
    // La mesure se fait donc par un TÉMOIN : le même backend, la même sonde,
    // mais le « proxy » est un simple écouteur TCP que le test démarre sur la
    // boucle locale. Témoin joignable : la machine laisse passer, alors le
    // proxy de Nodal DOIT l'être aussi, et son refus est une régression de
    // Nodal (rouge). Témoin injoignable : la machine jette les paquets du
    // conteneur vers la boucle locale de l'hôte ; le produit doit alors le dire
    // (`SANDBOX_PROXY_UNREACHABLE`, assertion réelle) et le contrat `available`
    // ne se prouve pas ici : le test est SAUTÉ en le disant.
    const controlStatus = async (): Promise<SandboxStatus> => {
      const listener = createServer((socket) => {
        // The probe's client leaves as soon as it is connected: a reset is its way out.
        socket.on('error', () => undefined);
        socket.end();
      });
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const { port } = listener.address() as AddressInfo;
      try {
        return await mxcBackend(undefined, 'proxy', {}, () =>
          Promise.resolve({
            url: `http://127.0.0.1:${port}`,
            refusedCount: () => 0,
            close: () => Promise.resolve(),
          }),
        ).probe();
      } finally {
        listener.close();
      }
    };

    it('régime proxy (produit) : `available` avec la limite raw-TCP si la machine laisse le conteneur joindre l’hôte ; sinon SANDBOX_PROXY_UNREACHABLE', async (ctx) => {
      const control = await controlStatus();
      const status = await mxcBackend().probe();
      if (control.state === 'unavailable') {
        // Le témoin n'est injoignable que par la machine : tout autre refus
        // (conteneur qui ne s'ouvre pas, palier) est un autre défaut, rouge.
        expect(control, JSON.stringify(control)).toMatchObject({
          state: 'unavailable',
          code: 'SANDBOX_PROXY_UNREACHABLE',
        });
        expect(status, JSON.stringify(status)).toMatchObject({
          state: 'unavailable',
          code: 'SANDBOX_PROXY_UNREACHABLE',
        });
        const missing =
          'precondition missing: this machine drops the packets of a container to the host loopback ' +
          `(control listener: ${control.reason}) (Nodal's proxy: ${status.reason}); the available contract of the proxy regime cannot be proven here`;
        // The default reporter does not print a skip note: the log must say it.
        console.warn(`SKIPPED régime proxy: ${missing}`);
        ctx.skip(missing);
        return;
      }
      expect(status, JSON.stringify(status)).toMatchObject({
        state: 'available',
        backend: MXC_BACKEND_NAME,
      });
      const codes = (status.state === 'available' ? (status.limits ?? []) : []).map(
        (l) => l.split(':')[0],
      );
      expect(codes).toEqual([
        'SANDBOX_DATA_DIR_NEW_CHILD',
        'SANDBOX_NETWORK_RAW_TCP_LOCAL',
        'SANDBOX_NETWORK_SHARED_LOOPBACK',
      ]);
    }, 240_000);

    it('régime deny-all (valeur de test de la CI) : `available`, aucun réseau, aucune limite réseau à dire (seule celle du dossier de données)', async () => {
      const status = await mxcBackend(undefined, 'deny-all').probe();
      expect(status, JSON.stringify(status)).toMatchObject({
        state: 'available',
        backend: MXC_BACKEND_NAME,
      });
      const codes = (status.state === 'available' ? (status.limits ?? []) : []).map(
        (l) => l.split(':')[0],
      );
      expect(codes).toEqual(['SANDBOX_DATA_DIR_NEW_CHILD']);
    }, 120_000);

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
