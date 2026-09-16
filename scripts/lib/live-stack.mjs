// scripts/lib/live-stack.mjs — est-ce qu'une stack de dev tourne ici ?
//
// `pnpm release:check` construit dans `apps/web/.next` et vide `pack/`. Lancée
// pendant qu'une stack de dev sert sur :3000, elle l'écrase en plein vol : le
// dashboard se met à rendre des 500, le runner perd ses fichiers, et le message
// qu'on lit à ce moment-là parle de build, jamais de la stack qu'on vient de
// tuer. On perd la session à chercher la mauvaise panne.
//
// La décision est donc prise AVANT tout le reste, elle échoue fort, et elle dit
// quoi faire : un worktree isolé, ou arrêter la stack. Les deux fonctions ici
// sont PURES — la sonde réseau vit dans `release-check.mjs` — pour que le
// verdict se teste sans ouvrir une seule socket.

/** Les ports où une stack de dev sert : le web et le runner. */
const DEFAUTS = { web: 3000, runner: 3001 };

/**
 * Les ports à sonder, lus dans `~/.nodalai/config.json` quand il existe.
 *
 * Postgres est délibérément absent : il survit très bien à un build, et le
 * sonder ferait échouer la commande sur une base laissée en route, qui ne
 * risque rien.
 *
 * Une clé ABSENTE garde le défaut — c'est le cas « pas de configuration », et
 * il est légitime. Une clé PRÉSENTE mais invalide (`"4000"`, `0`, `3000.5`)
 * JETTE : retomber en silence sur 3000 sonderait un port que personne n'a
 * demandé, laisserait la vraie stack invisible, et le build la tuerait. C'est
 * exactement l'invariant #4 — pas de repli intelligent silencieux.
 */
export function portsDeLaStack(config) {
  const lu = (cle) => {
    const v = config?.ports?.[cle];
    if (v === undefined || v === null) return DEFAUTS[cle];
    if (!Number.isInteger(v) || v <= 0 || v >= 65536) {
      throw new Error(
        `ports.${cle} = ${JSON.stringify(v)} in ~/.nodalai/config.json is not a port ` +
          `(expected an integer between 1 and 65535)`,
      );
    }
    return v;
  };
  return [...new Set([lu('web'), lu('runner')])];
}

/**
 * Le verdict, à partir des sondes déjà faites.
 *
 * UN seul port qui répond suffit : le build ne demande pas la permission aux
 * autres. Et une liste de sondes vide n'est pas une stack vivante — c'est une
 * absence de mesure, et crier là bloquerait la commande pour rien.
 */
export function verdictStackVivante(sondes) {
  const vivants = (sondes ?? []).filter((s) => s.vivant).map((s) => s.port);
  if (vivants.length === 0) return { vivante: false, ports: [], message: null };
  const liste = vivants.map((p) => `:${p}`).join(', ');
  return {
    vivante: true,
    ports: vivants,
    message:
      `a dev stack is running on ${liste}; release:check builds into apps/web/.next ` +
      `and would kill it: run it from an isolated worktree or stop the stack first`,
  };
}
