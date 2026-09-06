// project-key.ts — LA clé d'identité d'un projet, une seule fois.
//
// Un projet est identifié par son chemin. Deux écritures du même dossier
// doivent rendre la même clé — sinon masquer depuis une session laisserait le
// projet visible depuis une autre, et un verrou d'écriture posé par un agent
// ne serait pas vu par le suivant.
//
// Le repli sur `toLowerCase()` inconditionnel est FAUX hors Windows (revue
// Codex, 26/08) : sur un système sensible à la casse, `/srv/App` et `/srv/app`
// sont deux dossiers différents, et les confondre grouperait leurs sessions —
// renommer ou masquer l'un toucherait l'autre.
//
// Ce module vivait en TROIS copies jusqu'au 03/09 : le runner
// (`apps/runner/src/job/code-projects.ts`), le web
// (`apps/web/src/lib/project-key.ts`) et l'outil de code
// (`workspaceLockKey`, `packages/tools/src/builtin/code-task/db.ts`). Trois
// vérités qu'aucun écran ne pouvait départager. Le plan « Vérifier &
// Corriger » en fait la clé canonique d'un livrable : elle ne peut plus être
// dupliquée. Un scanner d'architecture (`scanForProjectKeyCopies`,
// `@nodal-agents/test-kit`) rougit si la règle de casse réapparaît ailleurs.
//
// Module SANS import Node : il est chargé aussi par le composant client de
// l'onglet Code, qui ne peut pas dépendre de `code-projects.ts` (node:fs).

/**
 * Chemin Windows ? Seuls ceux-là se replient en casse.
 *
 * Deux formes, pas une (revue Codex, 26/08) : la lettre de lecteur (`C:/…`) et
 * le partage réseau UNC, que la normalisation en slashes rend `//serveur/part`.
 * Les workspaces acceptent les deux depuis toujours — ne reconnaître que la
 * première traitait un partage Windows comme un chemin sensible à la casse,
 * donc dupliquait ses projets et ratait ses renommages.
 */
export const isWindowsPath = (p: string): boolean => /^[a-z]:\//i.test(p) || p.startsWith('//');

/**
 * Chemin absolu, sur l'un ou l'autre système : `C:/…` ou `/…`. Un partage UNC
 * (`//serveur/part`) commence par `/` et passe donc aussi.
 *
 * Vit ici, avec l'autre primitive d'identité de chemin, pour que l'expression
 * « lettre de lecteur » n'existe qu'à UN endroit du dépôt — c'est ce que le
 * scanner `scanForProjectKeyCopies` impose.
 */
export const isAbsolutePath = (p: string): boolean => /^[a-z]:\//i.test(p) || p.startsWith('/');

/**
 * Slashes uniformes, pas de slash final. `C:\Dev\App\` → `C:/Dev/App`.
 *
 * Exporté parce que trois appelants normalisaient déjà par eux-mêmes avant de
 * comparer : une seule normalisation, sinon les clés divergent sur le détail
 * qu'on croyait sans importance.
 */
export const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * `C:\Dev\App\` → `c:/dev/app` ; `\\srv\part\App` → `//srv/part/app` ;
 * `/srv/App` → `/srv/App` (casse préservée).
 */
export function projectKey(p: string): string {
  const s = normalizePath(p);
  return isWindowsPath(s) ? s.toLowerCase() : s;
}
