// release-check-flag.mjs — LE DRAPEAU qui dit que `release:check` tourne (#296).
//
// POURQUOI IL EXISTE. `release:check` dure quarante minutes et ne laisse AUCUNE
// trace qu'un autre programme puisse lire : c'est une commande locale, elle n'a
// ni run GitHub ni ligne en base. Le 20/09/2026 au matin, c'est elle qui
// tournait pendant que le portail montrait un Kanban vide et que le
// propriétaire demandait pourquoi rien n'était actif.
//
// POURQUOI DANS SON PROPRE MODULE. Une revue de la PR #326 a nommé ce qui
// manquait : le script de release n'est couvert par aucun test, et retirer
// l'appel qui pose le drapeau — c'est-à-dire tout le sujet de l'issue — ne
// faisait rougir personne. Ici, les trois gestes se testent contre un vrai
// dossier, et le script n'a plus qu'à les appeler.
//
// CE QUE CES FONCTIONS NE FONT JAMAIS : lever. Un portail qui ne saura pas que
// la commande tourne est un confort perdu ; refuser une release pour ça serait
// hors de proportion. Elles rendent donc ce qu'elles ont réussi à faire, et
// l'appelant n'a rien à rattraper.

import { writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Où vit le drapeau, à partir de la racine du dépôt.
 *
 * DANS LE DÉPÔT, pas dans le dossier personnel : le portail se collecte depuis
 * la racine, et un chemin absolu vers un autre disque ne se lirait pas depuis
 * une machine de CI. Ignoré par git — c'est un fichier de travail, pas un fait
 * à publier.
 */
export function cheminDuDrapeau(racine) {
  return join(racine, 'apps', 'qa', 'data', 'release-check.running.json');
}

/**
 * Pose le drapeau. Rend `true` s'il est écrit.
 *
 * `depuis` est l'instant du départ : c'est lui que la bande du portail montre
 * monter. `ou` nomme le dossier, parce que la commande se lance aussi depuis un
 * worktree isolé et qu'on veut savoir lequel travaille.
 */
export function poserLeDrapeau(racine, maintenant = new Date()) {
  try {
    writeFileSync(
      cheminDuDrapeau(racine),
      JSON.stringify({ depuis: maintenant.toISOString(), ou: basename(racine) }, null, 2),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** Retire le drapeau. Rend `true` s'il n'est plus là après l'appel. */
export function retirerLeDrapeau(racine) {
  try {
    rmSync(cheminDuDrapeau(racine), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Branche le retrait sur TOUTES les sorties du processus.
 *
 * ⚠️ `exit` NE SUFFIT PAS, et c'est un constat de la revue C de la PR #326 :
 * Node n'émet pas cet évènement quand le processus est tué par un SIGNAL. Un
 * Ctrl-C au milieu des quarante minutes laissait donc le drapeau en place, et
 * le portail annonçait « release:check, depuis 09:12 » pour toujours — une
 * bande qui ment, c'est-à-dire exactement ce que cette issue corrige, dans
 * l'autre sens.
 *
 * Les deux signaux réinstallent la mort qu'ils portent : on retire le drapeau,
 * puis on sort avec le code d'usage (128 + le numéro du signal), pour qu'un
 * shell qui enchaîne voie bien une interruption et non un succès.
 */
export function brancherLeRetrait(racine, process_ = process) {
  const retirer = () => retirerLeDrapeau(racine);
  process_.on('exit', retirer);
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process_.on(signal, () => {
      retirer();
      process_.exit(code);
    });
  }
}
