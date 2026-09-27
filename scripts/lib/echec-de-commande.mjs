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
 * Ce qui nomme un échec dans les sorties que `release:check` lance, par RANG :
 * d'abord ce qui nomme un TEST (vitest `FAIL`, `×`), puis ce qui nomme une
 * erreur de compilation ou de lint (tsc `error TS…`, eslint `12:5  error`),
 * puis toute erreur (`…Error:`). Le rang compte quand la limite coupe : des
 * `AssertionError` qu'un test VERT écrit dans la console ne doivent pas
 * pousser hors du message la ligne du test qui a échoué (revue Codex de la
 * PR #519). Aucun motif n'est ancré en début de ligne : turbo préfixe chaque
 * ligne par sa tâche (`@nodal-agents/web:lint: `).
 */
const RANGS = [
  [/(^|\s)FAIL\s/, /\s×\s/],
  [/\berror TS\d+:/, /(^|\s)\d+:\d+\s+error\s/],
  [/\b[A-Z][A-Za-z]*Error:/],
];

/** Les codes de couleur ANSI, qu'une sortie forcée en couleur mêle au texte. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Le préfixe de tâche que turbo pose sur chaque ligne (`@nodal-agents/web:test: `). */
const PREFIXE_TURBO = /^\S+:\S+: ?/;

/**
 * Une ligne qui NOMME un test en échec dit lequel, jamais pourquoi : vitest
 * écrit la cause sur la ligne suivante (`AssertionError: …` ou
 * `Error: Test timed out in 5000ms.` sous `FAIL`, `→ …` sous `×`). Sans elle,
 * un test qui expire — la forme la plus courante d'un test instable — perdait
 * sa cause, et deux tests rouges se partageaient des `AssertionError` qu'on ne
 * savait plus attribuer (#512). La ligne suivante est donc gardée, collée à son
 * test, sauf si elle est vide (préfixe turbo ôté) : c'est alors la fin du bloc ;
 * ou si elle nomme elle-même un test rouge : elle est retenue pour son compte,
 * avec SA cause, qu'on perdrait si elle passait pour celle de la précédente.
 */
function causeQuiSuit(lignes, i) {
  const suivante = lignes[i + 1];
  if (suivante === undefined) return false;
  if (RANGS[0].some((re) => re.test(suivante))) return false;
  return suivante.replace(PREFIXE_TURBO, '').trim() !== '';
}

/**
 * Les lignes qui nomment l'échec, au plus `max`, les plus précises d'abord
 * (voir `RANGS`), chacune à sa place dans la sortie au sein de son rang, un
 * test rouge suivi de sa cause (voir `causeQuiSuit`) ; puis une ligne qui dit
 * combien il en reste.
 */
export function lignesDeLEchec(sortie, max = 40) {
  const lignes = sortie.replace(ANSI, '').split(/\r?\n/);
  const retenues = [];
  const vues = new Set();
  RANGS.forEach((motifs, rang) => {
    lignes.forEach((l, i) => {
      if (vues.has(i) || !motifs.some((re) => re.test(l))) return;
      vues.add(i);
      retenues.push(l);
      if (rang === 0 && !vues.has(i + 1) && causeQuiSuit(lignes, i)) {
        vues.add(i + 1);
        retenues.push(lignes[i + 1]);
      }
    });
  });
  if (retenues.length <= max) return retenues;
  return [
    ...retenues.slice(0, max),
    `… ${retenues.length - max} more failure lines in the full log`,
  ];
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
  const fichier = join(dossier, nomDeFichier(commande));
  // L'écriture du journal ne doit jamais REMPLACER l'échec qu'elle documente :
  // un disque plein ou un dossier interdit est dit à la place du chemin, et le
  // message garde les lignes et la fin (revue Codex de la PR #519).
  let ecrit;
  try {
    mkdirSync(dossier, { recursive: true });
    writeFileSync(fichier, sortie);
    ecrit = `full output: ${fichier}`;
  } catch (err) {
    ecrit = `full output could not be written to ${fichier}: ${err.code ?? err.message}`;
  }
  const nommees = lignesDeLEchec(sortie);
  const derniere = sortie.replace(ANSI, '').trim().split(/\r?\n/).slice(-fin);
  const corps =
    nommees.length > 0
      ? [...nommees, '', 'last lines:', ...derniere]
      : ['no line names the failure; last lines:', ...derniere];
  return {
    fichier,
    message: `\`${commande}\` failed:\n    ${corps.join('\n    ')}\n    ${ecrit}`,
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
