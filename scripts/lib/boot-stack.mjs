// boot-stack.mjs — lancer la stack et l'attendre en suivant son PROCESSUS.
//
// Voir scripts/tests/boot-stack.test.mjs pour le pourquoi (#514). En bref : une
// attente aveugle sonde un port sans savoir si la stack vit encore, et un
// lancement en `&` perd sa sortie à la fin de l'étape. Ici, la sortie entière va
// dans un journal, et l'attente s'arrête sur l'un des trois faits suivants :
// la stack répond, le lanceur est mort, ou le filet (le plafond) est atteint.

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

/**
 * Attend la stack. Les effets (horloge, sonde, état du processus) sont injectés :
 * la décision se teste sans processus ni socket.
 *
 * @param {{
 *   sonder: () => Promise<boolean>,
 *   sortie: () => ({ code: number | null } | null),
 *   maintenant: () => number,
 *   attendre: (ms: number) => Promise<void>,
 *   plafondMs: number,
 *   pasMs: number,
 * }} p
 * @returns {Promise<{ etat: 'prete', apresMs: number } | { etat: 'morte', code: number | null, apresMs: number } | { etat: 'plafond', apresMs: number }>}
 */
export async function attendreLaStack({ sonder, sortie, maintenant, attendre, plafondMs, pasMs }) {
  const debut = maintenant();
  for (;;) {
    const ecoule = maintenant() - debut;
    // La sonde passe AVANT l'état du processus : un lanceur qui rend la main
    // après avoir servi n'est pas une stack morte.
    if (await sonder()) return { etat: 'prete', apresMs: ecoule };
    const fin = sortie();
    if (fin) return { etat: 'morte', code: fin.code, apresMs: ecoule };
    if (ecoule >= plafondMs) return { etat: 'plafond', apresMs: ecoule };
    await attendre(pasMs);
  }
}

/** Les `n` dernières lignes d'un texte, sans la ligne vide qui suit le dernier saut. */
export function finDuJournal(texte, n) {
  return texte.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}

/**
 * Toute réponse HTTP compte, redirection comprise : un dashboard en mode
 * `local-auth` répond 307 vers /login, et c'est une stack prête.
 */
async function repond(url) {
  if (!url) return false;
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Lance `commande` DÉTACHÉE (elle survit à ce script : les étapes suivantes du
 * workflow jouent contre elle), sortie standard et d'erreur dans `journal`, puis
 * attend. `url` peut être une fonction, relue à chaque sonde.
 */
export async function lancerEtAttendre({
  commande,
  args,
  env = process.env,
  url,
  journal,
  plafondMs,
  pasMs = 2_000,
}) {
  const fd = openSync(journal, 'a');
  const enfant = spawn(commande, args, { detached: true, stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  let fin = null;
  enfant.on('exit', (code) => {
    fin = { code };
  });
  // Un lanceur introuvable (`spawn ENOENT`) est une mort, pas une attente.
  enfant.on('error', () => {
    fin = { code: null };
  });
  enfant.unref();

  const verdict = await attendreLaStack({
    sonder: () => repond(typeof url === 'function' ? url() : url),
    sortie: () => fin,
    maintenant: () => Date.now(),
    attendre: (ms) => new Promise((r) => setTimeout(r, ms)),
    plafondMs,
    pasMs,
  });
  return { ...verdict, pid: enfant.pid };
}
