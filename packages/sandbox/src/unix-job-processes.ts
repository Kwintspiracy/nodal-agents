// unix-job-processes.ts — retrouver, sous Unix, les processus d'un job qui ont
// quitté le groupe de leur commande (#750).
//
// Chaque commande non confinée d'un job est cheffe de son groupe de processus
// (`detached: true`), et la fin du job tue chaque groupe. Ce qui s'en échappe
// (mesuré en CI Linux, unix-job-processes.test.ts) : un descendant qui ouvre
// sa propre session (`setsid`, un démon qui fait le double fork) — il n'est
// plus dans le groupe, et son parent est mort.
//
// Ce qui le retrouve sans droits root : l'ENVIRONNEMENT. Chaque commande d'un
// job reçoit `NODAL_JOB_SCOPE=<id du job>`, et tout descendant le reçoit à sa
// naissance, quel que soit son groupe ou sa session. Sous Linux,
// `/proc/<pid>/environ` donne l'environnement initial de chaque processus du
// même utilisateur ; la fin du job tue ceux qui portent l'étiquette du job,
// et rien d'autre (l'identifiant est un uuid : un autre Nodal sur la même
// machine — une autre base — ne peut pas porter le même).
//
// Ce qui échappe encore, dit et non deviné :
//   - un descendant lancé avec un environnement VIDÉ (`env -i`, `sudo`, un
//     gestionnaire de services : `systemd-run --user`, `docker run` — ces deux
//     derniers ne sont même pas des descendants). La forme complète serait un
//     cgroup par job (`systemd-run --user --scope`) : elle exige une session
//     systemd utilisateur avec délégation, absente des conteneurs, de WSL sans
//     systemd et de macOS — pas une base fiable sans root ;
//   - sous macOS, il n'y a pas de `/proc` : un descendant `setsid` y survit à
//     son job (le groupe, lui, est tué). La lecture équivalente passerait par
//     `sysctl(KERN_PROCARGS2)` (ce que lit `ps -E`) ; elle n'est pas écrite,
//     faute d'une machine macOS en CI pour la prouver.

import { readFileSync, readdirSync } from 'node:fs';

/** La variable qui nomme le job d'un processus, posée sur chaque commande. */
export const JOB_SCOPE_ENV = 'NODAL_JOB_SCOPE';

/**
 * Les pid des processus de ce système qui portent l'étiquette du job `id`, ou
 * `null` quand ce système ne sait pas les lire (pas de `/proc` : macOS).
 */
export function pidsTaggedWith(id: string, procRoot = '/proc'): number[] | null {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const needle = Buffer.from(`${JOB_SCOPE_ENV}=${id}\0`);
  const out: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: Buffer;
    try {
      environ = readFileSync(`${procRoot}/${name}/environ`);
    } catch {
      // Un processus d'un autre utilisateur (EACCES), ou sorti entre-temps.
      continue;
    }
    const at = environ.indexOf(needle);
    // En tête du bloc, ou juste après le NUL qui clôt la variable précédente.
    if (at === 0 || (at > 0 && environ[at - 1] === 0)) out.push(pid);
  }
  return out;
}

/**
 * Tue les processus étiquetés du job `id`, jusqu'à ce qu'il n'en reste aucun
 * (un processus qui fork pendant le balayage est repris au tour suivant).
 * Rend ceux qui vivent encore après le dernier tour, et `null` quand ce
 * système ne sait pas les lire.
 */
export async function killTaggedProcesses(
  id: string,
  procRoot = '/proc',
  rounds = 5,
): Promise<number[] | null> {
  let tagged = pidsTaggedWith(id, procRoot);
  if (tagged === null) return null;
  for (let round = 0; round < rounds && tagged.length > 0; round++) {
    for (const pid of tagged) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* sorti entre-temps */
      }
    }
    // Le noyau retire le processus tué ; un zombie n'a plus d'environnement
    // lisible, il ne compte plus.
    await new Promise((r) => setTimeout(r, 50));
    tagged = pidsTaggedWith(id, procRoot) ?? [];
  }
  return tagged;
}

/**
 * Ce système retrouve-t-il un descendant DÉTACHÉ d'un job (sorti du groupe de
 * sa commande : `setsid`, double fork) ? Windows : oui, le Job Object le tient.
 * Unix : seulement là où l'environnement des processus se lit (`/proc`,
 * Linux) — pas sous macOS, limite dite en tête de ce fichier. Ce que les
 * tests disent qu'ils prouvent se règle là-dessus, jamais sur un nom d'OS
 * deviné.
 */
export function detachedDescendantsReachable(): boolean {
  if (process.platform === 'win32') return true;
  try {
    readFileSync('/proc/self/environ');
    return true;
  } catch {
    return false;
  }
}
