// lib/workspace-list.ts — les dossiers qu'un agent voit RÉELLEMENT.
//
// UN AGENT, UN DOSSIER (décision Quentin, 26/08).
//
// Le workspace partagé de l'espace était injecté à TOUS les agents, y compris
// à ceux à qui le propriétaire avait explicitement attaché un dossier. C'est la
// racine d'une journée entière de symptômes :
//
//   * le PROMPT ne listait pas le partagé — sa liste vient de
//     `agent_workspaces` — alors que les OUTILS l'avaient. L'agent lisait
//     « ton seul dossier est Dev, tout est relatif à sa racine », écrivait
//     `shared/outputs/x.html` (les outils routaient correctement vers le
//     partagé), puis construisait le chemin absolu en COLLANT les deux :
//     `C:\…\Documents\Dev\shared\outputs\x.html`. Un chemin qui n'existe nulle
//     part, et dont le début juste le rend crédible ;
//   * l'onglet Code ne connaît que les dossiers attachés : tout ce qui partait
//     dans le partagé lui était invisible ;
//   * il a fallu une consigne de prompt, une section de skill et une règle de
//     délégation pour rattraper l'ambiguïté — trois rustines sur une cause.
//
// Le « hand-off entre agents » que le partagé servait à justifier passe déjà
// par le dossier ATTACHÉ quand il est commun : cinq agents d'une même équipe
// partageant `Documents/Dev` se relisent sans passer par ailleurs.
//
// Extrait de `executeJob` (1 500 lignes) pour être testable : la règle tient en
// une ligne, mais elle décide de tout ce qui précède.

/** Un dossier tel que les outils le voient. */
export interface WorkspaceEntry {
  label: string;
  path: string;
}

/**
 * La liste finale : les dossiers attachés, ou le partagé s'il n'y en a AUCUN.
 *
 * Jamais les deux. Rendre `null` pour `sharedPath` signifie « pas de partagé
 * pour cet agent » — ce qui vaut aussi quand sa création a échoué.
 */
export function resolveWorkspaceList(
  attached: ReadonlyArray<WorkspaceEntry>,
  sharedLabel: string,
  sharedPath: string | null,
): { workspaces: WorkspaceEntry[]; sharedPath: string | null } {
  if (attached.length > 0) return { workspaces: [...attached], sharedPath: null };
  if (!sharedPath) return { workspaces: [], sharedPath: null };
  return { workspaces: [{ label: sharedLabel, path: sharedPath }], sharedPath };
}
