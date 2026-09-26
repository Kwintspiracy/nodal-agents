// boot-stack.mjs — lancer la stack et l'attendre en suivant son PROCESSUS.
//
// Voir scripts/tests/boot-stack.test.mjs pour le pourquoi (#514). En bref : une
// attente aveugle sonde un port sans savoir si la stack vit encore, et un
// lancement en `&` perd sa sortie à la fin de l'étape. Ici, la sortie entière va
// dans un journal, et l'attente s'arrête sur l'un des faits suivants : l'adresse
// était déjà prise avant le lancement, le lanceur est mort, la stack répond, ou
// le filet (le plafond) est atteint.

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

/**
 * Attend la stack. Les effets (horloge, sonde, état du processus) sont injectés :
 * la décision se teste sans processus ni socket.
 *
 * La mort du lanceur passe AVANT la sonde, et elle est relue après une sonde
 * positive : c'est le CLI qui décide. Quand son propre délai de santé expire, il
 * s'arrête en laissant parfois des enfants qui finissent par répondre ; une
 * réponse à ce moment-là n'est pas une stack prête, c'est une stack que son
 * lanceur a déclarée en échec (revue Codex de la PR #516).
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
  const morte = (fin) => ({ etat: 'morte', code: fin.code, apresMs: maintenant() - debut });
  for (;;) {
    const avant = sortie();
    if (avant) return morte(avant);
    if (await sonder()) {
      const apres = sortie();
      if (apres) return morte(apres);
      return { etat: 'prete', apresMs: maintenant() - debut };
    }
    const ecoule = maintenant() - debut;
    if (ecoule >= plafondMs) return { etat: 'plafond', apresMs: ecoule };
    await attendre(pasMs);
  }
}

/** Les `n` dernières lignes d'un texte, sans la ligne vide qui suit le dernier saut. */
export function finDuJournal(texte, n) {
  return texte.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}

/**
 * Le critère de `curl -f`, que les deux workflows utilisaient : une réponse
 * sous 400. Une redirection compte (un dashboard en `local-auth` répond 307
 * vers /login, et c'est une stack prête) ; une 404 ou une 500 non.
 */
export function estPrete(status) {
  return status < 400;
}

async function repond(url) {
  if (!url) return false;
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return estPrete(r.status);
  } catch {
    return false;
  }
}

/**
 * Lance `commande` DÉTACHÉE (elle survit à ce script : les étapes suivantes du
 * workflow jouent contre elle), sortie standard et d'erreur dans `journal`, puis
 * attend. `url` peut être une fonction, relue à chaque sonde.
 *
 * Si l'adresse répond AVANT le lancement, rien n'est lancé : ce qui répondrait
 * ensuite ne serait pas la stack, et les étapes suivantes testeraient autre chose
 * (revue Codex de la PR #516).
 *
 * `shell` : sous Windows, `pnpm` est un `.cmd`, que Node refuse de lancer sans
 * shell (`spawn EINVAL`).
 */
export async function lancerEtAttendre({
  commande,
  args,
  env = process.env,
  url,
  journal,
  plafondMs,
  pasMs = 2_000,
  shell = false,
}) {
  const adresse = () => (typeof url === 'function' ? url() : url);
  if (await repond(adresse())) return { etat: 'occupee', apresMs: 0, pid: null };

  const fd = openSync(journal, 'a');
  // En mode shell, Node concatène les arguments sans les échapper (DEP0190) :
  // la ligne est donc écrite ici, et un argument qui contient un espace ou un
  // guillemet est refusé plutôt que découpé en silence par `cmd`.
  if (shell && args.some((a) => /[\s"'^&|<>()%]/.test(a))) {
    closeSync(fd);
    throw new Error(
      `boot-stack: an argument cannot go through a shell unescaped: ${JSON.stringify(args)}`,
    );
  }
  // `detached` sert à survivre à ce script sous Linux et macOS (nouveau groupe
  // de processus). Sous Windows un enfant survit déjà à son parent, et
  // `detached` lui donne une console à lui : la sortie de ses propres enfants
  // (pnpm → node) n'arrive plus dans le journal.
  const options = {
    detached: process.platform !== 'win32',
    stdio: ['ignore', fd, fd],
    env,
    windowsHide: true,
  };
  const enfant = shell
    ? spawn([commande, ...args].join(' '), { ...options, shell })
    : spawn(commande, args, options);
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
    sonder: () => repond(adresse()),
    sortie: () => fin,
    maintenant: () => Date.now(),
    attendre: (ms) => new Promise((r) => setTimeout(r, ms)),
    plafondMs,
    pasMs,
  });
  return { ...verdict, pid: enfant.pid };
}
