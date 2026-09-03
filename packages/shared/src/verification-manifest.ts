// verification-manifest.ts — le contrat de hash du manifeste de preuve (D1).
//
// Une commande de preuve est un POUVOIR : un agent qui modifie package.json
// contrôle ce que `pnpm test` lance. D'où l'approbation par empreinte : seule
// la révision exacte que l'owner a validée s'exécute. Le manifeste couvre tout
// ce qui change le sens de la preuve — les commandes ET leur ordre, les
// invariants déclarés, la cible, le répertoire, et les versions de la
// politique shell et de l'allowlist d'environnement. Changer l'un d'eux
// invalide l'approbation entière ; il n'existe qu'UN hash et qu'UNE
// approbation par cible (plan v6.2, passe 8).
//
// Pourquoi ce module vit ici et pas dans tools : le web (qui approuve) et le
// runner (qui prouve) doivent hasher PAREIL, et shared ne peut pas importer
// tools. Les deux versions ci-dessous sont épinglées dans tools par un
// test-snapshot qui rougit si l'allowlist change sans bump.
//
// Pourquoi une sha-256 en JS pur : ce package est bundlé côté client (voir
// project-key.ts) et n'a aucun import `node:`. `crypto.subtle` existe partout
// mais est asynchrone, ce qui aurait fait fuir une Promise dans chaque
// signature pour un hash de quelques centaines d'octets. L'implémentation est
// la référence FIPS 180-4, testée en parité contre node:crypto.

/**
 * Version de la politique shell (quoting, tree-kill, capture) sous laquelle
 * une commande a été approuvée. Un changement de politique change ce qu'une
 * commande FAIT — donc ce qui a été approuvé.
 */
export const SHELL_POLICY_VERSION = 1;

/**
 * Version de l'allowlist des variables d'environnement transmises à la
 * preuve. Élargir l'allowlist expose plus au code du dépôt : nouvelle version,
 * nouvelle approbation.
 */
export const ENV_ALLOWLIST_VERSION = 1;

/** Préfixe de version du hash — un futur contrat produira `v2:`. */
export const MANIFEST_HASH_VERSION = 'v1';

/** Le manifeste hashé. `verifierConfig` est propre au type de livrable. */
export interface VerificationManifest {
  /** Pour `code_project` : la liste ordonnée des commandes de preuve entière. */
  verifierConfig: unknown;
  /** Toujours présent — `[]` tant que l'owner n'en a pas déclaré. */
  invariants: readonly unknown[];
  canonicalKey: string;
  cwd: string;
  shellPolicyVersion: number;
  envAllowlistVersion: number;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Sérialisation JSON canonique : clés triées récursivement, aucun espace,
 * UTF-8 au moment du hash. Deux manifestes égaux à l'ordre des clés près
 * produisent la même chaîne ; l'ORDRE d'un tableau, lui, compte — c'est
 * l'ordre des commandes.
 *
 * `undefined` et les fonctions sont refusés : un champ absent n'est pas un
 * champ vide, et laisser `JSON.stringify` les taire ferait hasher deux
 * manifestes différents pareil.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) throw new TypeError(`canonicalJson: undefined at key "${key}"`);
      out[key] = canonicalize(v);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

/**
 * `v1:` + sha-256 hexadécimale de la sérialisation canonique des six champs.
 * Les six sont toujours présents dans la chaîne hashée — `invariants: []` et
 * l'absence du champ ne sont pas la même chose.
 */
export function hashVerificationManifest(m: VerificationManifest): string {
  const canonical = canonicalJson({
    verifierConfig: m.verifierConfig,
    invariants: m.invariants,
    canonicalKey: m.canonicalKey,
    cwd: m.cwd,
    shellPolicyVersion: m.shellPolicyVersion,
    envAllowlistVersion: m.envAllowlistVersion,
  });
  return `${MANIFEST_HASH_VERSION}:${sha256Hex(canonical)}`;
}

// ─── sha-256 (FIPS 180-4), JS pur ─────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** sha-256 hexadécimale (64 caractères) d'une chaîne, encodée en UTF-8. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  // Padding : 0x80, zéros, longueur sur 64 bits big-endian.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
