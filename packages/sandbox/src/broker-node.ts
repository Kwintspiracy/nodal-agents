// broker-node.ts — le Node qui fait tourner le courtier MXC, sous Windows.
//
// Le SDK MXC lit la sortie standard d'un processus confiné par des flux natifs
// qui exigent Node ≥ 24.21 (ou ≥ 26.8) sous Windows (voir windows-mxc.ts). Le
// Node de l'utilisateur peut être plus ancien (26.4 chez Quentin). Plutôt que
// de dépendre de SA version, Nodal fait tourner le courtier sur un Node À LUI :
// un build officiel épinglé, téléchargé une fois depuis nodejs.org, et gardé
// sous le dossier des scripts du bac à sable. UN seul chemin : le courtier
// tourne TOUJOURS sur ce Node, quelle que soit la version de l'utilisateur —
// pas de branche « sa version suffit ».
//
// Sa somme SHA-256 est ÉPINGLÉE dans ce fichier (BROKER_NODE_SHA256), jamais
// lue d'un SHASUMS venu par le même canal que le binaire. Elle est vérifiée au
// téléchargement, puis À CHAQUE LANCEMENT du courtier (MxcBroker.start, par
// `verifyPinnedNodeSync`) : le courtier, hors conteneur, n'exécute jamais un
// binaire dont la somme a changé (#628, P1-2). Le dossier n'est d'ailleurs
// inscriptible par aucune commande confinée (D1 le refuse, ne le rouvre qu'en
// lecture).
//
// Indisponible (réseau coupé, somme fausse) : on le DIT, avec un code, et la
// commande tourne sans bac à sable (jamais un repli silencieux sur le Node de
// l'utilisateur). La sonde réessaie au prochain processus.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxHostDir } from './job-host';

/**
 * La version épinglée du Node du courtier : la dernière 24 LTS (Krypton) au
 * 2026-10-14. Au-dessus du plancher du SDK (24.21) ; montée à la main, testée.
 */
export const BROKER_NODE_VERSION = '24.22.0';

/**
 * La somme SHA-256 attendue du `node.exe` officiel, ÉPINGLÉE ICI par arch
 * (#628, P1-2). On la vérifie au téléchargement ET avant chaque lancement,
 * contre cette valeur du code — pas contre un SHASUMS256.txt venu du même
 * canal que le binaire (qui ne prouverait rien si le canal est compromis).
 * Relevées de https://nodejs.org/dist/v24.22.0/SHASUMS256.txt le 2026-10-15.
 * À changer EN MÊME TEMPS que BROKER_NODE_VERSION.
 */
export const BROKER_NODE_SHA256: Record<'win-x64' | 'win-arm64', string> = {
  'win-x64': 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c',
  'win-arm64': 'df4b0e71e4e4d022bf8582fbe75f6061feb9c4a111a86f3fec6300d24b6fe5e0',
};

/** `process.arch` → le dossier d'arch de nodejs.org. Les seuls supportés. */
function winArch(arch: string): 'win-x64' | 'win-arm64' {
  if (arch === 'x64') return 'win-x64';
  if (arch === 'arm64') return 'win-arm64';
  throw new Error(`unsupported Windows arch for the broker Node: ${arch}`);
}

/**
 * Où le Node du courtier est gardé : SOUS LE DOSSIER DES SCRIPTS DU BAC À
 * SABLE (sandboxHostDir, ~/.nodalai/sandbox), donc sous le dossier de données
 * de Nodal — que le bac à sable REFUSE en écriture à une commande confinée
 * (D1) et ne re-concède qu'en lecture. Jamais sous le cache d'outils, qui est
 * une racine INSCRIPTIBLE : une commande confinée aurait pu y réécrire le
 * node.exe que le courtier (non confiné) relance (#628, P1-2).
 */
export function brokerNodeDir(version = BROKER_NODE_VERSION, arch: string = process.arch): string {
  return join(sandboxHostDir(), 'broker-node', version, winArch(arch));
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

/** Ce qu'on injecte pour les tests : d'où lire, quoi récupérer, quelle somme. */
export interface BrokerNodeDeps {
  /** Base des URLs nodejs.org ; une barre finale. */
  readonly distBaseUrl?: string;
  /** Récupère une URL en octets (node.exe). */
  readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * La somme attendue, pour les tests qui servent un faux node.exe (le produit
   * ne la passe jamais : il vérifie contre `BROKER_NODE_SHA256` épinglé).
   */
  readonly expectedSha256?: string;
}

const DEFAULT_BASE = 'https://nodejs.org/dist/';
const defaultFetchBytes = async (url: string): Promise<Uint8Array> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};

const inFlight = new Map<string, Promise<string>>();

/**
 * Le chemin du Node du courtier, téléchargé (et vérifié contre la somme
 * épinglée) s'il est absent. Un binaire PRÉSENT n'est pas re-haché ici : il
 * l'est à chaque lancement, par `verifyPinnedNodeSync` — un seul endroit. Un
 * seul téléchargement à la fois par (version, arch). Lève
 * `BrokerNodeUnavailable` si le réseau échoue ou si la somme ne correspond pas
 * — jamais de repli.
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

/** La somme épinglée attendue pour cette arch (ou celle qu'un test injecte). */
export function pinnedBrokerNodeSha(
  deps: BrokerNodeDeps = {},
  arch: string = process.arch,
): string {
  return deps.expectedSha256 ?? BROKER_NODE_SHA256[winArch(arch)];
}

/**
 * Vérifie, juste avant de LANCER le courtier, que `path` a la somme
 * `expected`. Sinon le binaire est SUPPRIMÉ (la prochaine ouverture le
 * retélécharge, vérifié) et `BrokerNodeUnavailable` est levée : rien n'est
 * lancé. Synchrone : `spawn` l'est, et c'est le seul moment qui compte.
 */
export function verifyPinnedNodeSync(path: string, expected: string): void {
  let got: string;
  try {
    got = createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (e) {
    throw new BrokerNodeUnavailable(
      `cannot read the broker Node at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (got === expected) return;
  try {
    unlinkSync(path);
  } catch {
    /* déjà parti, ou verrouillé : il ne sera pas lancé de toute façon */
  }
  throw new BrokerNodeUnavailable(
    `broker Node at ${path} has SHA-256 ${got}, not the pinned ${expected}: discarded, not launched`,
  );
}

async function download(deps: BrokerNodeDeps, version: string, arch: string): Promise<string> {
  const a = winArch(arch);
  const base = deps.distBaseUrl ?? DEFAULT_BASE;
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const expected = deps.expectedSha256 ?? BROKER_NODE_SHA256[a];
  const dir = brokerNodeDir(version, arch);
  const path = join(dir, 'node.exe');
  try {
    const bytes = await fetchBytes(`${base}v${version}/${a}/node.exe`);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== expected) {
      throw new Error(`SHA-256 mismatch for ${a}/node.exe: expected ${expected}, got ${got}`);
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
