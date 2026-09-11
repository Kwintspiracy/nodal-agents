// written-file-type.ts — un fichier que l'agent écrit est-il du CODE ou un
// DOCUMENT ? La règle, mécanique, à un seul endroit.
//
// Plan « Créer, c'est prouver », point 3. `file_write` et `file_edit`
// déclaraient `code_project` en dur : un skill (`SKILL.md`, `base.css`,
// `base.html`) écrit dans le dossier partagé devenait un « projet de code »,
// Nodal cherchait ses commandes de test, n'en trouvait pas, et affichait « non
// configuré » sur un travail qui n'avait rien à lancer. Le plan v7-A disait
// pourtant : « `code_project` seulement si le fichier appartient au projet ».
//
// La règle, zéro LLM et zéro extension (rien dans un chemin ne distingue
// `data/fixtures/x.csv`, qui est du code, de `rapport.csv`, qui n'en est pas) :
//
//   le fichier est sous un projet de code — une racine qui PORTE UN MANIFESTE
//   (la même règle que l'intention et le registre, `resolveProjectRoots` +
//   `hasMarker`), ou un projet DÉCLARÉ (`code_projects.registered_at` non nul,
//   de `kind = 'code'`) ⇒ `code_project` ;
//   sinon ⇒ `document`.
//
// Pourquoi le manifeste compte autant que la déclaration : le registre se
// remplit tout seul (P5b) à partir des cibles `code_project` qui portent un
// manifeste. Ne regarder que la déclaration aurait typé `document` le premier
// `package.json` d'un dépôt neuf — et plus rien ne l'aurait jamais déclaré.
//
// Pourquoi un projet déclaré de DOCUMENTS ne compte pas : ses fichiers sont
// des documents, précisément. `kind` existe pour que l'écran le dise ; ici il
// sert à ne pas transformer un dossier de notes en dépôt à tester.

import { and, eq, isNotNull } from '@nodal-agents/db';
import { codeProjects } from '@nodal-agents/db';
import type { DeliverableType } from '@nodal-agents/shared';
import { isWithinRoot, normalizePath, resolveProjectRoots } from '@nodal-agents/shared';
import { hasMarker, rebaseOntoLexicalRoots } from '../projects/markers';
import type { ToolContext } from '../types';

export type WrittenFileType = Extract<DeliverableType, 'code_project' | 'document'>;

export interface ClassifyWrittenFileInput {
  /** Le chemin ABSOLU résolu par l'outil (`resolveAndCheckPath`). */
  readonly absPath: string;
  readonly workspaceRoots: readonly string[];
  /** Les chemins des projets DÉCLARÉS de kind `code` (normalisés ou non). */
  readonly declaredCodeProjectPaths: readonly string[];
  readonly hasMarker: (dir: string) => boolean;
}

/** La règle, pure — testable sans disque ni base. */
export function classifyWrittenFile(input: ClassifyWrittenFileInput): WrittenFileType {
  const path = normalizePath(input.absPath);
  const dir = path.replace(/\/[^/]*$/, '');

  for (const declared of input.declaredCodeProjectPaths) {
    const root = normalizePath(declared);
    if (root !== '' && isWithinRoot(dir, root)) return 'code_project';
  }

  const [project] = resolveProjectRoots({
    targets: [{ kind: 'file', path, deliverableType: 'code_project' }],
    workspaceRoots: input.workspaceRoots,
    hasMarker: input.hasMarker,
  });
  if (project !== undefined && input.hasMarker(project.path)) return 'code_project';

  return 'document';
}

/**
 * Le type du fichier que CET appel va écrire, lu depuis le contexte de
 * l'outil : les dossiers attachés, et les projets déclarés de l'espace.
 */
export async function deliverableTypeForWrittenFile(
  ctx: ToolContext,
  absPath: string,
): Promise<WrittenFileType> {
  // Le chemin RÉEL rendu par l'outil est d'abord ramené sous la racine telle
  // qu'ÉCRITE (une racine attachée par jonction ou lien garde son nom) — la
  // même règle que l'intention, sinon un fichier sous une racine liée ne
  // tombe « dans » aucune racine et devient un document par accident.
  const workspaceRoots = (ctx.workspaces ?? []).map((w) => w.path);
  const [rebased] = rebaseOntoLexicalRoots(
    [{ kind: 'file', path: absPath, deliverableType: 'document' }],
    workspaceRoots,
  );
  const rows = await ctx.db
    .select({ path: codeProjects.projectPath })
    .from(codeProjects)
    .where(
      and(
        eq(codeProjects.entityId, ctx.entityId),
        isNotNull(codeProjects.registeredAt),
        eq(codeProjects.kind, 'code'),
      ),
    );
  return classifyWrittenFile({
    absPath: rebased?.path ?? absPath,
    workspaceRoots,
    declaredCodeProjectPaths: rows.map((r) => r.path),
    hasMarker,
  });
}
