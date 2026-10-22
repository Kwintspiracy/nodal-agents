// install-playwright.mjs — installer les navigateurs de Playwright sans dépendre
// du miroir apt quand on n'en a pas besoin, et sans se heurter à soi-même quand
// il faut s'en servir (#852).
//
// Le défaut qu'on remplace : `timeout 300 playwright install --with-deps` dans
// une boucle. `timeout` ne tuait que `pnpm` ; l'`apt-get` lancé plus bas par
// Playwright (via sudo) survivait, orphelin, et gardait le verrou dpkg. Les
// tentatives 2 et 3 échouaient aussitôt sur « Could not get lock … held by
// process N (apt-get) » : la boucle ne réessayait rien, elle butait sur son
// propre orphelin. Trois fois le 22/10/2026 (runs 39767924868, 39771651908,
// 39773781284).
//
// Trois règles ici :
//   1. rien n'est lancé « en vrac » : chaque commande réseau tourne sous
//      `timeout --kill-after`, qui vise tout le GROUPE du processus, donc les
//      petits-enfants (apt-get, dpkg, les méthodes http) avec lui ;
//   2. entre deux tentatives, on regarde que plus aucun apt/dpkg ne tourne, et
//      on le dit — un verrou encore tenu est un fait à journaliser, pas à deviner ;
//   3. une panne se dit « browser install failed » (annotation + code 1), pour ne
//      jamais passer pour un test rouge.

import { spawn } from 'node:child_process';

/** Le code de `timeout` quand la commande a dépassé sa borne. */
export const CODE_TIMEOUT = 124;

/** Les options apt qui bornent le RÉSEAU (et non toute l'étape en bloc). */
export const OPTIONS_APT = [
  // Une méthode http qui n'a rien reçu depuis 20 s est abandonnée, puis
  // réessayée par apt lui-même, sans repartir de zéro.
  '-o',
  'Acquire::Retries=3',
  '-o',
  'Acquire::http::Timeout=20',
  '-o',
  'Acquire::https::Timeout=20',
  // Un verrou dpkg tenu par un tiers (unattended-upgrades au démarrage du
  // runner) est ATTENDU 60 s au lieu de faire échouer apt sur-le-champ.
  '-o',
  'DPkg::Lock::Timeout=60',
];

/**
 * Lit la sortie de `playwright install-deps --dry-run`.
 * @returns {string[] | null} les paquets listés (vide : tout est installé), ou
 *   `null` si la sortie n'est NI l'un NI l'autre — la sonde elle-même a échoué.
 */
export function paquetsDeLaSonde(sortie) {
  if (/All system dependencies are installed\./.test(sortie)) return [];
  const m = sortie.match(/Missing system dependencies \(\d+\):\n((?:[ \t]+\S+\n?)+)/);
  if (!m) return null;
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parmi `paquets`, ceux qui ne sont PAS installés, d'après la sortie de
 * `dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n'`.
 *
 * La sonde de Playwright liste aussi les paquets installés qui ont une mise à
 * jour en attente (`apt-get install -s` imprime `Inst` pour eux). Chromium n'en a
 * pas besoin : on n'installe que ce qui manque vraiment, et c'est ce qui permet
 * de ne toucher à apt sur aucun runner dont l'image est déjà bonne.
 */
export function vraimentManquants(paquets, sortieDpkg) {
  const installes = new Set();
  for (const ligne of sortieDpkg.split('\n')) {
    const [nom, statut] = ligne.trim().split(/\s+/);
    if (nom && statut === 'installed') installes.add(nom.replace(/:.*$/, ''));
  }
  return paquets.filter((p) => !installes.has(p.replace(/:.*$/, '')));
}

/**
 * La commande entière d'une tentative : `timeout` d'abord, pour qu'il soit le
 * parent du travail et en tue tout le groupe. Un préfixe (sudo) passe AVANT lui :
 * le `timeout` qui tue est alors root, comme apt-get, et peut l'atteindre.
 */
export function commandeBornee({ prefixe = [], secondes, graceSecondes = 15, commande, args }) {
  return [
    ...prefixe,
    'timeout',
    `--kill-after=${graceSecondes}`,
    String(secondes),
    commande,
    ...args,
  ];
}

/**
 * Lance une commande sous `timeout`, sortie héritée (le journal de la CI montre
 * ce que fait apt). Résout avec son code ; `CODE_TIMEOUT` (124) ou 137 (tuée) :
 * la borne a joué.
 */
export function lancerBornee({ prefixe, secondes, graceSecondes, commande, args, env }) {
  const [exe, ...reste] = commandeBornee({ prefixe, secondes, graceSecondes, commande, args });
  return new Promise((resolve, reject) => {
    const enfant = spawn(exe, reste, { stdio: 'inherit', env: env ?? process.env });
    enfant.on('error', reject);
    enfant.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Une phrase pour un code de sortie, pour le journal. */
export function decrire(code) {
  if (code === CODE_TIMEOUT || code === 137) return `cut off by its ${code} time bound`;
  return `exit code ${code}`;
}

/** L'échec d'une phase, après toutes ses tentatives. */
export class EchecInstallation extends Error {
  constructor(phase, tentatives, dernierCode) {
    super(
      `browser install failed in phase "${phase}": ${tentatives} attempt(s), last one ${decrire(dernierCode)}`,
    );
    this.name = 'EchecInstallation';
    this.phase = phase;
  }
}

/**
 * Une phase = une commande bornée, réessayée. `essai(n)` rend le code de sortie
 * de la tentative n ; `entre(n)` tourne ENTRE deux tentatives (c'est là que le
 * script vérifie que le verrou est libre). Rend le numéro de la tentative qui a
 * réussi ; lève `EchecInstallation` sinon.
 */
export async function avecReessais({ phase, tentatives, essai, entre, journal }) {
  let code = 1;
  for (let n = 1; n <= tentatives; n++) {
    code = await essai(n);
    if (code === 0) return n;
    journal(`${phase}: attempt ${n}/${tentatives} failed (${decrire(code)})`);
    if (n < tentatives) await entre(n);
  }
  throw new EchecInstallation(phase, tentatives, code);
}
