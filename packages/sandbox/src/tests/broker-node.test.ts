// broker-node.test.ts — le Node dédié du courtier : téléchargé une fois,
// vérifié contre une somme SHA-256 ÉPINGLÉE DANS LE CODE (#628, D5 + P1-2),
// gardé SOUS LE DOSSIER DES SCRIPTS DU BAC À SABLE (hors des racines
// inscriptibles par une commande confinée) ; un échec se DIT avec un code,
// jamais un repli. Les téléchargements et la somme attendue sont injectés :
// ce test ne touche pas le réseau et sert un faux node.exe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROKER_NODE_VERSION,
  BROKER_NODE_SHA256,
  BrokerNodeUnavailable,
  ensureBrokerNode,
  brokerNodeDir,
  readCachedSha,
  verifyPinnedNodeSync,
  pinnedBrokerNodeSha,
  type BrokerNodeDeps,
} from '../broker-node';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodal-brokernode-'));
  prev = process.env['NODALAI_SANDBOX_DIR'];
  // Le Node du courtier vit sous sandboxHostDir() ; on le redirige vers un
  // temporaire (comme le fait test-kit) pour ne pas écrire dans le vrai ~/.nodalai.
  process.env['NODALAI_SANDBOX_DIR'] = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env['NODALAI_SANDBOX_DIR'];
  else process.env['NODALAI_SANDBOX_DIR'] = prev;
  rmSync(dir, { recursive: true, force: true });
});

const FAKE = Buffer.from('fake node.exe bytes');
const FAKE_SHA = createHash('sha256').update(FAKE).digest('hex');
const ARCH = 'x64';

function deps(overrides: Partial<BrokerNodeDeps> = {}): BrokerNodeDeps {
  return {
    distBaseUrl: 'https://example.test/dist/',
    expectedSha256: FAKE_SHA,
    fetchBytes: async (url) => {
      expect(url).toBe(`https://example.test/dist/v${BROKER_NODE_VERSION}/win-x64/node.exe`);
      return FAKE;
    },
    ...overrides,
  };
}

describe('broker Node pin @cap:executer-une-commande/moteur', () => {
  it('la somme épinglée est un SHA-256 (64 hexa) pour chaque arch Windows', () => {
    for (const arch of ['win-x64', 'win-arm64'] as const) {
      expect(BROKER_NODE_SHA256[arch]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('ensureBrokerNode @cap:executer-une-commande/moteur', () => {
  it('télécharge, vérifie la somme, et garde le node.exe sous le dossier du bac à sable', async () => {
    const path = await ensureBrokerNode(deps(), BROKER_NODE_VERSION, ARCH);
    expect(path).toBe(join(brokerNodeDir(BROKER_NODE_VERSION, ARCH), 'node.exe'));
    expect(path.toLowerCase()).toContain(join(dir, 'broker-node').toLowerCase());
    expect(existsSync(path)).toBe(true);
    expect(await readCachedSha(BROKER_NODE_VERSION, ARCH)).toBe(FAKE_SHA);
  });

  it('une somme qui ne correspond pas lève BrokerNodeUnavailable, et n’écrit rien', async () => {
    const bad = deps({ fetchBytes: async () => Buffer.from('tampered') });
    await expect(ensureBrokerNode(bad, BROKER_NODE_VERSION, ARCH)).rejects.toBeInstanceOf(
      BrokerNodeUnavailable,
    );
    expect(existsSync(join(brokerNodeDir(BROKER_NODE_VERSION, ARCH), 'node.exe'))).toBe(false);
  });

  it('réseau coupé : BrokerNodeUnavailable avec le code et l’erreur réelle', async () => {
    const offline = deps({
      fetchBytes: async () => {
        throw new Error('getaddrinfo ENOTFOUND nodejs.org');
      },
    });
    const err = await ensureBrokerNode(offline, BROKER_NODE_VERSION, ARCH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerNodeUnavailable);
    expect((err as BrokerNodeUnavailable).code).toBe('SANDBOX_BROKER_NODE_UNAVAILABLE');
    expect((err as BrokerNodeUnavailable).message).toMatch(/ENOTFOUND nodejs\.org/);
  });

  it('un node.exe en cache dont la somme CORRESPOND n’est pas retéléchargé', async () => {
    await ensureBrokerNode(deps(), BROKER_NODE_VERSION, ARCH);
    let touched = false;
    const second = deps({
      fetchBytes: async () => {
        touched = true;
        return FAKE;
      },
    });
    const path = await ensureBrokerNode(second, BROKER_NODE_VERSION, ARCH);
    expect(existsSync(path)).toBe(true);
    expect(touched).toBe(false);
  });

  it('un node.exe ALTÉRÉ est écarté au lancement, puis retéléchargé (vérifié) à l’ouverture suivante', async () => {
    const path = await ensureBrokerNode(deps(), BROKER_NODE_VERSION, ARCH);
    writeFileSync(path, Buffer.from('tampered')); // réécrit
    expect(() => verifyPinnedNodeSync(path, FAKE_SHA)).toThrow(BrokerNodeUnavailable);
    expect(existsSync(path)).toBe(false); // écarté, jamais lancé
    let refetched = false;
    const again = deps({
      fetchBytes: async () => {
        refetched = true;
        return FAKE;
      },
    });
    await ensureBrokerNode(again, BROKER_NODE_VERSION, ARCH);
    expect(refetched).toBe(true);
    expect(await readCachedSha(BROKER_NODE_VERSION, ARCH)).toBe(FAKE_SHA);
  });
});

describe('verifyPinnedNodeSync @cap:executer-une-commande/moteur', () => {
  it('passe sur la somme épinglée ; lève BrokerNodeUnavailable si le fichier manque', () => {
    const path = join(dir, 'node.exe');
    writeFileSync(path, FAKE);
    expect(() => verifyPinnedNodeSync(path, FAKE_SHA)).not.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(() => verifyPinnedNodeSync(join(dir, 'gone.exe'), FAKE_SHA)).toThrow(
      BrokerNodeUnavailable,
    );
  });

  it('le produit vérifie contre la somme épinglée de l’arch, pas contre une valeur reçue', () => {
    expect(pinnedBrokerNodeSha({}, 'x64')).toBe(BROKER_NODE_SHA256['win-x64']);
    expect(pinnedBrokerNodeSha({}, 'arm64')).toBe(BROKER_NODE_SHA256['win-arm64']);
  });
});
