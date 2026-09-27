// echec-de-commande.mjs — ce qu'une commande en échec doit laisser derrière elle.
//
// Voir scripts/tests/echec-de-commande.test.mjs (#512). Deux choses, pour toute
// commande : la sortie ENTIÈRE dans un fichier dont le chemin est donné, et dans
// le message les lignes qui NOMMENT l'échec — où qu'elles soient dans la sortie,
// pas seulement à la fin, où turbo ne met que son résumé.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ce qui nomme un échec dans les sorties que `release:check` lance : vitest
 * (`FAIL`, `×`, l'assertion), tsc (`error TS…`), eslint (`  12:5  error  …`),
 * et toute erreur Node (`…Error:`). Une ligne préfixée par turbo
 * (`@nodal-agents/web:test: `) est reconnue de la même façon.
 */
const NOMME_UN_ECHEC = [
  /(^|\s)FAIL\s/,
  /\s×\s/,
  /\b[A-Z][A-Za-z]*Error:/,
  /\berror TS\d+:/,
  /^\s*\d+:\d+\s+error\s/,
];

/** Les lignes qui nomment l'échec, au plus `max`, puis une ligne qui dit combien il en reste. */
export function lignesDeLEchec(sortie, max = 40) {
  const lignes = sortie.split(/\r?\n/).filter((l) => NOMME_UN_ECHEC.some((re) => re.test(l)));
  if (lignes.length <= max) return lignes;
  return [...lignes.slice(0, max), `… ${lignes.length - max} more failure lines in the full log`];
}

/** Un nom de fichier stable pour une commande : `pnpm test` → `pnpm-test.log`. */
function nomDeFichier(commande) {
  return `${commande.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}.log`;
}

/**
 * Écrit la sortie entière de `commande` dans `dossier` et rend le message à
 * afficher : les lignes qui nomment l'échec, la fin de la sortie (le résumé de
 * l'outil), et le chemin du fichier.
 */
export function rapportDEchec({ commande, sortie, dossier, fin = 8 }) {
  mkdirSync(dossier, { recursive: true });
  const fichier = join(dossier, nomDeFichier(commande));
  writeFileSync(fichier, sortie);
  const nommees = lignesDeLEchec(sortie);
  const derniere = sortie.trim().split(/\r?\n/).slice(-fin);
  const corps =
    nommees.length > 0
      ? [...nommees, '', 'last lines:', ...derniere]
      : ['no line names the failure; last lines:', ...derniere];
  return {
    fichier,
    message: `\`${commande}\` failed:\n    ${corps.join('\n    ')}\n    full output: ${fichier}`,
  };
}

/**
 * Lance `commande` (une ligne de shell) et rend sa sortie standard ; si elle
 * échoue, jette une erreur dont le message est celui de `rapportDEchec`. Une
 * erreur de LANCEMENT (`ENOBUFS` au-delà de `maxBuffer`, un signal) est ajoutée
 * à la sortie : elle n'y est pas d'elle-même, et c'est parfois toute la cause.
 */
export function lancerOuRapporter(commande, { cwd, dossier, maxBuffer = 64 * 1024 * 1024 }) {
  const r = spawnSync(commande, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer,
  });
  if (r.status === 0 && !r.error) return r.stdout ?? '';
  const lancement = r.error ? `\n${r.error.name}: ${r.error.message}` : '';
  const signal = r.signal ? `\nkilled by ${r.signal}` : '';
  const { message } = rapportDEchec({
    commande,
    sortie: `${r.stdout ?? ''}${r.stderr ?? ''}${lancement}${signal}`,
    dossier,
  });
  throw new Error(message);
}
