// broker-node.ts — le Node qui fait tourner le courtier MXC, sous Windows.
//
// Le SDK MXC lit la sortie standard d'un processus confiné par des flux natifs
// qui exigent Node ≥ 24.21 (ou ≥ 26.8) sous Windows (voir windows-mxc.ts). Le
// Node de l'utilisateur peut être plus ancien (26.4 chez Quentin). Plutôt que
// de dépendre de SA version, Nodal fait tourner le courtier sur un Node À LUI :
// un build officiel épinglé, téléchargé une fois depuis nodejs.org, vérifié
// contre SHASUMS256.txt, et gardé dans le cache d'outils. UN seul chemin : le
// courtier tourne TOUJOURS sur ce Node, quelle que soit la version de
// l'utilisateur — pas de branche « sa version suffit ».
//
// Le binaire vit sous le cache d'outils (`toolCacheRoot()`), que le bac à sable
// laisse LISIBLE (deniedPaths épargne le cache) : le courtier, hors conteneur,
// le lance ; un conteneur peut le lire, ce qui est sans risque.
//
// Indisponible (réseau coupé, somme fausse) : on le DIT, avec un code, et la
// commande tourne sans bac à sable (jamais un repli silencieux sur le Node de
// l'utilisateur). La sonde réessaie au prochain processus.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toolCacheRoot } from './policy';

/**
 * La version épinglée du Node du courtier : la dernière 24 LTS (Krypton) au
 * 2026-10-14. Au-dessus du plancher du SDK (24.21) ; montée à la main, testée.
 */
export const BROKER_NODE_VERSION = '24.22.0';

/** `process.arch` → le dossier d'arch de nodejs.org. Les seuls supportés. */
function winArch(arch: string): 'win-x64' | 'win-arm64' {
  if (arch === 'x64') return 'win-x64';
  if (arch === 'arm64') return 'win-arm64';
  throw new Error(`unsupported Windows arch for the broker Node: ${arch}`);
}

/** Où le Node du courtier est gardé, sous le cache d'outils (donc lisible). */
export function brokerNodeDir(version = BROKER_NODE_VERSION, arch: string = process.arch): string {
  return join(toolCacheRoot(), 'broker-node', version, winArch(arch));
}

function brokerNodePath(version = BROKER_NODE_VERSION, arch: string = process.arch): string {
  return join(brokerNodeDir(version, arch), 'node.exe');
}

/** L'erreur levée quand le Node du courtier ne peut pas être obtenu. */
export class BrokerNodeUnavailable extends Error {
  readonly code = 'SANDBOX_BROKER_NODE_UNAVAILABLE';
  constructor(reason: string) {
    super(reason);
    this.name = 'BrokerNodeUnavailable';
  }
}

/** Ce qu'on injecte pour les tests : d'où lire, et comment récupérer un octet. */
export interface BrokerNodeDeps {
  /** Base des URLs nodejs.org ; une barre finale. */
  readonly distBaseUrl?: string;
  /** Récupère une URL en texte (SHASUMS256.txt). */
  readonly fetchText?: (url: string) => Promise<string>;
  /** Récupère une URL en octets (node.exe). */
  readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
}

const DEFAULT_BASE = 'https://nodejs.org/dist/';
const defaultFetchText = async (url: string): Promise<string> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
};
const defaultFetchBytes = async (url: string): Promise<Uint8Array> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};

/** La somme attendue de `win-<arch>/node.exe`, lue dans SHASUMS256.txt. */
function expectedSha(shasums: string, arch: 'win-x64' | 'win-arm64'): string {
  for (const line of shasums.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === `${arch}/node.exe` && sha) return sha.toLowerCase();
  }
  throw new Error(`SHASUMS256.txt has no entry for ${arch}/node.exe`);
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Le chemin du Node du courtier, téléchargé et vérifié si besoin. Un seul
 * téléchargement à la fois par (version, arch). Lève `BrokerNodeUnavailable`
 * si le réseau échoue ou si la somme ne correspond pas — jamais de repli.
 */
export function ensureBrokerNode(
  deps: BrokerNodeDeps = {},
  version = BROKER_NODE_VERSION,
  arch: string = process.arch,
): Promise<string> {
  const path = brokerNodePath(version, arch);
  if (existsSync(path)) return Promise.resolve(path);
  const key = `${version}:${arch}`;
  let p = inFlight.get(key);
  if (!p) {
    p = download(deps, version, arch).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function download(deps: BrokerNodeDeps, version: string, arch: string): Promise<string> {
  const a = winArch(arch);
  const base = deps.distBaseUrl ?? DEFAULT_BASE;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const dir = brokerNodeDir(version, arch);
  const path = join(dir, 'node.exe');
  try {
    const shasums = await fetchText(`${base}v${version}/SHASUMS256.txt`);
    const want = expectedSha(shasums, a);
    const bytes = await fetchBytes(`${base}v${version}/${a}/node.exe`);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want) {
      throw new Error(`SHA-256 mismatch for ${a}/node.exe: expected ${want}, got ${got}`);
    }
    await mkdir(dir, { recursive: true });
    // Écriture atomique : un fichier temporaire renommé, pour qu'un node.exe
    // présent soit toujours complet et vérifié.
    const tmp = `${path}.${process.pid}.part`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    return path;
  } catch (e) {
    throw new BrokerNodeUnavailable(
      `could not obtain Node ${version} (${a}) for the sandbox broker: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Relecture d'un node.exe en cache, pour vérifier sa somme (tests). */
export async function readCachedSha(
  version = BROKER_NODE_VERSION,
  arch: string = process.arch,
): Promise<string | null> {
  const path = brokerNodePath(version, arch);
  if (!existsSync(path)) return null;
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
