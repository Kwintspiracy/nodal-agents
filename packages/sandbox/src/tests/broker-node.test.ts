// broker-node.test.ts — le Node dédié du courtier : téléchargé une fois,
// vérifié contre SHASUMS256.txt, gardé dans le cache d'outils ; un échec se
// DIT avec un code, jamais un repli (#628, D5). Les téléchargements sont
// injectés : ce test ne touche pas le réseau.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROKER_NODE_VERSION,
  BrokerNodeUnavailable,
  ensureBrokerNode,
  brokerNodeDir,
  readCachedSha,
  type BrokerNodeDeps,
} from '../broker-node';

let cache: string;
let prev: string | undefined;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'nodal-brokernode-'));
  prev = process.env['NODALAI_TOOL_CACHE_ROOT'];
  process.env['NODALAI_TOOL_CACHE_ROOT'] = cache;
});
afterEach(() => {
  if (prev === undefined) delete process.env['NODALAI_TOOL_CACHE_ROOT'];
  else process.env['NODALAI_TOOL_CACHE_ROOT'] = prev;
  rmSync(cache, { recursive: true, force: true });
});

const FAKE = Buffer.from('fake node.exe bytes');
const FAKE_SHA = createHash('sha256').update(FAKE).digest('hex');
const ARCH = 'x64';

function deps(overrides: Partial<BrokerNodeDeps> = {}): BrokerNodeDeps {
  return {
    distBaseUrl: 'https://example.test/dist/',
    fetchText: async (url) => {
      expect(url).toBe(`https://example.test/dist/v${BROKER_NODE_VERSION}/SHASUMS256.txt`);
      return `${FAKE_SHA}  win-x64/node.exe\n0000  win-arm64/node.exe\n`;
    },
    fetchBytes: async (url) => {
      expect(url).toBe(`https://example.test/dist/v${BROKER_NODE_VERSION}/win-x64/node.exe`);
      return FAKE;
    },
    ...overrides,
  };
}

describe('ensureBrokerNode @cap:executer-une-commande/moteur', () => {
  it('télécharge, vérifie la somme, et garde le node.exe sous le cache d’outils', async () => {
    const path = await ensureBrokerNode(deps(), BROKER_NODE_VERSION, ARCH);
    expect(path).toBe(join(brokerNodeDir(BROKER_NODE_VERSION, ARCH), 'node.exe'));
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
      fetchText: async () => {
        throw new Error('getaddrinfo ENOTFOUND nodejs.org');
      },
    });
    const err = await ensureBrokerNode(offline, BROKER_NODE_VERSION, ARCH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerNodeUnavailable);
    expect((err as BrokerNodeUnavailable).code).toBe('SANDBOX_BROKER_NODE_UNAVAILABLE');
    expect((err as BrokerNodeUnavailable).message).toMatch(/ENOTFOUND nodejs\.org/);
  });

  it('un node.exe déjà en cache n’est pas retéléchargé', async () => {
    await ensureBrokerNode(deps(), BROKER_NODE_VERSION, ARCH);
    let touched = false;
    const second = deps({
      fetchText: async () => {
        touched = true;
        return '';
      },
      fetchBytes: async () => {
        touched = true;
        return FAKE;
      },
    });
    const path = await ensureBrokerNode(second, BROKER_NODE_VERSION, ARCH);
    expect(existsSync(path)).toBe(true);
    expect(touched).toBe(false);
  });
});
