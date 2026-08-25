// project-key.ts — LA clé d'identité d'un projet, partagée serveur et client.
//
// Un projet est identifié par son chemin. Deux écritures du même dossier
// doivent donc rendre la même clé — sinon masquer depuis une session laisserait
// le projet visible depuis une autre.
//
// Le repli sur `toLowerCase()` inconditionnel est FAUX hors Windows (revue
// Codex, 26/08) : sur un système sensible à la casse, `/srv/App` et `/srv/app`
// sont deux dossiers différents, et les confondre grouperait leurs sessions
// ensemble — renommer ou masquer l'un toucherait l'autre. On ne replie donc la
// casse que pour les chemins Windows, exactement comme `samePath`.
//
// Module SANS import Node : il est chargé aussi par le composant client de
// l'onglet Code, qui ne peut pas dépendre de `code-projects.ts` (node:fs).
// Le runner porte son jumeau dans apps/runner/src/job/code-projects.ts — les
// deux doivent répondre pareil, faute de quoi un projet masqué dans
// l'interface resterait annoncé aux agents.

/** Chemin Windows (`C:/…`) ? Seuls ceux-là se replient en casse. */
const isWindowsPath = (p: string): boolean => /^[a-z]:\//i.test(p);

/** `C:\Dev\App\` → `c:/dev/app` ; `/srv/App` → `/srv/App` (casse préservée). */
export function projectKey(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsPath(norm) ? norm.toLowerCase() : norm;
}
