// lib/workspace-list.ts — les dossiers qu'un agent voit RÉELLEMENT.
//
// UNE SEULE LISTE, celle que les outils ont (décision Quentin, 26/08).
//
// Le défaut d'origine : le PROMPT construisait sa liste par une requête sur
// `agent_workspaces`, pendant que les OUTILS recevaient cette liste PLUS le
// workspace partagé, injecté ici. Deux sources pour une même vérité, et le
// prompt mentait :
//
//   « Your workspace label is **Dev** […] bare relative paths […] both resolve
//     to the same root »
//
// L'agent écrivait donc `shared/outputs/x.html` — que les outils routaient
// correctement vers le partagé — puis, croyant tout relatif à `Dev`, annonçait
// `C:\…\Documents\Dev\shared\outputs\x.html`. Un chemin qui n'existe nulle
// part, et dont le début juste le rend crédible.
//
// PREMIÈRE TENTATIVE, ÉCARTÉE : ne plus injecter le partagé aux agents qui ont
// un dossier. Ça réglait le symptôme et cassait autre chose — objection de
// Quentin, décisive : « si mon agent a besoin de partager un fichier avec un
// autre agent, comment il fait ? » Le partagé est le SEUL terrain commun entre
// un agent qui tient un coffre Obsidian et un agent qui génère des images. Le
// retirer à quiconque reçoit un dossier les désolidarise du reste de l'équipe.
// Mon raisonnement généralisait depuis un cas particulier — cinq agents dev
// partageant `Documents/Dev`, donc se relisant sans le partagé.
//
// On répare un mensonge en disant la vérité, pas en amputant une capacité :
// tout le monde garde le partagé, et le prompt liste ce que les outils ont.

/** Un dossier tel que les outils le voient. */
export interface WorkspaceEntry {
  label: string;
  path: string;
}

/**
 * La liste finale : les dossiers attachés, PLUS le workspace partagé.
 *
 * Le partagé arrive en dernier — l'ordre compte, le prompt présente le premier
 * comme le dossier de référence, et c'est celui du propriétaire.
 *
 * `sharedPath` à `null` signifie que sa création a échoué : on n'invente alors
 * aucune entrée, plutôt que d'offrir un dossier qui n'existe pas.
 */
export function resolveWorkspaceList(
  attached: ReadonlyArray<WorkspaceEntry>,
  sharedLabel: string,
  sharedPath: string | null,
): { workspaces: WorkspaceEntry[]; sharedPath: string | null } {
  if (!sharedPath) return { workspaces: [...attached], sharedPath: null };
  if (attached.some((w) => w.label === sharedLabel)) {
    return { workspaces: [...attached], sharedPath };
  }
  return { workspaces: [...attached, { label: sharedLabel, path: sharedPath }], sharedPath };
}
