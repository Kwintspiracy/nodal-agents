// file-ops/workspace-list.ts — les dossiers qu'un agent voit RÉELLEMENT.
//
// Vivait dans apps/runner/src/lib jusqu'au 27/09 (#506, revue Codex P1) : le
// bloc d'équipe de l'orchestrateur listait les dossiers de chaque agent par
// sa propre requête, sans le partagé, et annonçait « Folders: none » pour un
// agent qui lisait et écrivait le partagé. La règle est ici, dans un paquet
// que le runner ET l'orchestration importent, et `resolveRunWorkspaces` est
// le seul point qui la lit en base.
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

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { eq } from '@nodal-agents/db';
import { agentWorkspaces } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { workspacesRoot } from './workspaces-root';
import { SHARED_WORKSPACE_LABEL } from './workspace';

/** Un dossier tel que les outils le voient. */
export interface WorkspaceEntry {
  label: string;
  path: string;
}

/**
 * Le dossier PARTAGÉ d'un espace, créé au besoin. `null` si on n'a pas pu.
 *
 * Il n'a AUCUNE ligne dans `agent_workspaces` : il est fabriqué à l'exécution.
 * Une requête sur cette table ne le trouve donc jamais — et c'est exactement ce
 * qui manquait au chemin CHAT (revue Codex, 27/08) : un agent en runtime CLI ne
 * pouvait ni lire ni écrire les fichiers de transmission de l'équipe depuis le
 * tableau de bord, et un agent SANS dossier attaché y échouait en
 * `workspace_not_configured` alors que ses jobs, eux, tournaient très bien.
 *
 * Sorti ici pour que les deux points d'entrée du runtime construisent la même
 * liste — la duplication est précisément ce qui a laissé le chat en arrière.
 */
export function ensureSharedWorkspace(entityId: string | null): string | null {
  if (!entityId) return null;
  const sharedPath = join(workspacesRoot(), entityId, 'shared');
  try {
    mkdirSync(sharedPath, { recursive: true });
    return sharedPath;
  } catch {
    // best-effort — un dossier qu'on n'a pas su créer n'est simplement pas offert
    return null;
  }
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

/**
 * Les dossiers d'un run de `agentId` : ceux qui lui sont attachés, dans
 * l'ordre choisi par le propriétaire, PUIS le partagé de l'espace. La liste
 * que reçoivent les outils, le prompt, une session de CLI — et le bloc
 * d'équipe qui la décrit à l'orchestrateur. Une seule source.
 */
export async function resolveRunWorkspaces(
  db: AnyDrizzleDb,
  agentId: string,
  entityId: string | null,
): Promise<{
  workspaces: WorkspaceEntry[];
  sharedPath: string | null;
  attached: WorkspaceEntry[];
}> {
  const attached = await db
    .select({ label: agentWorkspaces.label, path: agentWorkspaces.path })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.agentId, agentId))
    .orderBy(agentWorkspaces.position, agentWorkspaces.label);
  return {
    ...resolveWorkspaceList(attached, SHARED_WORKSPACE_LABEL, ensureSharedWorkspace(entityId)),
    attached,
  };
}
