// Built-in: register_project — la réponse à « où écrire ? » devient un projet
// (P10b, plan « De la maquette au produit »).
//
// LA RÈGLE DE QUENTIN (P5) : « Hors de tout projet, l'agent demande OÙ avant
// d'écrire ; la réponse crée le projet. Rien ne se crée en silence. » Depuis
// P5b, un dossier à MANIFESTE où du code atterrit se déclare tout seul : la
// question ne porte plus que sur les DOCUMENTS — un rapport, une note, un
// classeur — que rien ne permet de ranger.
//
// LE FLUX, en trois appels : `ask_user` (P10a) pose la question avec les
// projets déclarés en options et un « New project: <nom> » ; l'utilisateur
// choisit ; l'agent appelle CET outil, qui crée le dossier, le déclare au
// registre et y rattache le job ET la conversation ; puis il écrit dedans, et
// Spaces montre le projet, son fichier et sa conversation.
//
// CE QUI TIENT LA RÈGLE « rien en silence » : `computeApproval` ci-dessous. Il
// ne suffit pas que l'outil existe — sans question répondue dans ce job, la
// création passe par la carte d'approbation ordinaire.
//
// INVARIANT #2 : rien ici ne fabrique de phrase pour l'utilisateur. La sortie
// est une ligne de données ; c'est le LLM qui la raconte.

import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path/posix';
import { z } from 'zod';
import { and, eq, approvalRequests, codeProjects } from '@nodal-agents/db';
import { isSafeSubfolder, projectKey } from '@nodal-agents/shared';
import type { ToolDefinition, ToolContext } from '../types';
import { textCard, failureText } from '../presenters';
import { resolveAndCheckPath, WorkspaceError } from './file-ops/workspace';
import { registerCodeProjects } from '../projects/register';
import { attachProductionToProject } from '../projects/attach';

export const REGISTER_PROJECT_PATH_MAX = 200;
export const REGISTER_PROJECT_NAME_MAX = 80;

export const RegisterProjectInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(REGISTER_PROJECT_PATH_MAX)
    .describe(
      'Folder for the project, addressed like any file path you write: ' +
        '"<workspace-label>/<subfolder>", or just "<subfolder>" when you only have one ' +
        'workspace. Created if it does not exist.',
    ),
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(REGISTER_PROJECT_NAME_MAX))
    .optional()
    .describe(
      'Display name for the project. Omitted: the folder name is used. Ignored when the ' +
        'folder is already a registered project — the name its owner gave it stands.',
    ),
  kind: z
    .enum(['documents', 'code'])
    .optional()
    .default('documents')
    .describe('What this project produces. Documents unless it is a code repository.'),
});

export type RegisterProjectInput = z.infer<typeof RegisterProjectInputSchema>;

export type RegisterProjectOutput =
  | {
      ok: true;
      project_id: string;
      path: string;
      name: string;
      kind: 'code' | 'documents';
      /** False when the folder was ALREADY a registered project — nothing was declared. */
      created: boolean;
    }
  | { ok: false; reason: string };

/**
 * Une question a-t-elle été posée ET répondue dans CE job ?
 *
 * Portée au JOB, pas à l'appel : la question est posée par `ask_user`, avec son
 * propre `tool_call_id`, et c'est un appel DIFFÉRENT de celui-ci. Les lier par
 * l'id d'appel — ce que fait le plancher `asksUser` d'execute.ts — ne
 * trouverait jamais rien ici.
 *
 * `approved` seulement : une question DÉCLINÉE n'est pas une réponse, et
 * laisser passer la création sur un refus serait exactement le silence que la
 * règle interdit.
 */
async function jobHasAnsweredQuestion(db: ToolContext['db'], jobId: string): Promise<boolean> {
  if (!jobId) return false;
  const [row] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.jobId, jobId),
        eq(approvalRequests.kind, 'question'),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export const registerProjectTool: ToolDefinition<
  typeof RegisterProjectInputSchema,
  RegisterProjectOutput
> = {
  name: 'register_project',
  description:
    'Create a project: a folder in your workspace, registered so it appears in Spaces with ' +
    'the work and conversations that belong to it. ' +
    'Use it when the person answered "new project" to a question you asked with `ask_user` ' +
    'about where a document should go, or when they ask you outright to start a project. ' +
    'Do NOT use it for code that lands in a folder carrying a manifest (package.json, .git, ' +
    'pyproject.toml, …): that folder registers itself as a project the moment you write in ' +
    'it, so just write. Do NOT use it for a folder that is already a registered project ' +
    'either — writing into it is enough, and it stays attached to this conversation. ' +
    'After this call, write your files under the returned `path`.',
  inputSchema: RegisterProjectInputSchema,
  riskLevel: 'write',
  // Carte `text` : la sortie est une ligne de DONNÉES (un id, un chemin, un
  // nom), pas une structure à dessiner — il n'y a ni fichier écrit, ni table,
  // ni terminal à montrer.
  card: 'text',
  // `false`, et ce n'est pas un oubli : créer un dossier VIDE ne mute aucun
  // livrable. Il n'y a rien à re-prouver (pas d'intention de mutation) et rien
  // à restaurer (pas d'instantané) — le premier `file_write` qui y atterrira,
  // lui, déclarera les deux. Le rattachement au projet, cet outil le fait
  // lui-même dans `execute` : le seam ne le fera pas pour lui.
  mutatesWorkspace: false,
  present: ({ output }) =>
    output.ok
      ? textCard({
          project_id: output.project_id,
          path: output.path,
          name: output.name,
          kind: output.kind,
          created: output.created,
        })
      : failureText(output.reason),
  /**
   * LA GARDE « rien ne se crée en silence ».
   *
   * Sans question répondue dans ce job, créer un projet passe par la carte
   * d'approbation ORDINAIRE : le propriétaire voit le dossier proposé et
   * tranche. Avec une question répondue, il a DÉJÀ tranché — redemander
   * transformerait sa réponse en deux clics pour une seule décision.
   *
   * Pas de `defaultApproval` : une règle explicite du propriétaire (un
   * `auto_approve` posé sur cet outil, ou un `block`) garde la précédence,
   * comme pour `file_write`. Et sous `fully_autonomous` le hook n'est même pas
   * appelé — c'est le choix explicite du propriétaire, la même mécanique que
   * l'écrasement gaté de `file_write`, pas un contournement.
   */
  computeApproval: async (_input, ctx) =>
    (await jobHasAnsweredQuestion(ctx.db, ctx.jobId)) ? undefined : 'require_approval',
  execute: async (input, ctx): Promise<RegisterProjectOutput> => {
    let abs: string;
    try {
      abs = await resolveAndCheckPath(ctx, input.path);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        // Hors terrain : le seul refus que l'agent doit lire comme tel, et le
        // même mot que `file_write` rendrait. Les autres erreurs de résolution
        // (plusieurs terrains sans étiquette, terrain illisible) portent une
        // consigne exploitable dans leur message — la perdre ferait deviner.
        return {
          ok: false,
          reason: err.code === 'path_traversal_blocked' ? 'outside_workspace' : err.message,
        };
      }
      throw err;
    }

    // LA MÊME règle que le bouton « New project » de Spaces
    // (`isSafeSubfolder`, @nodal-agents/shared) : des segments relatifs, et
    // rien d'autre. Un chemin qui désigne le terrain LUI-MÊME est accepté —
    // Spaces l'accepte (`subfolder: ''`), et un dépôt attaché tel quel est
    // exactement ce cas. Appliquée APRÈS la résolution pour que `../hors`
    // rende `outside_workspace`, le mot qui décrit vraiment ce qui cloche.
    if (!isSafeSubfolder(input.path)) {
      return { ok: false, reason: 'unsafe_path' };
    }

    try {
      await mkdir(abs, { recursive: true });
    } catch (err) {
      // Fail loud (invariant #4) : une ligne sans dossier serait un projet
      // fantôme, listé dans Spaces et vide sur le disque.
      console.error(`[projects] PROJECT_MKDIR_FAILED key=${projectKey(abs)}`, err);
      return { ok: false, reason: 'mkdir_failed' };
    }

    const key = projectKey(abs);
    const declared = await registerCodeProjects(ctx.db, {
      entityId: ctx.entityId,
      agentId: ctx.agentId,
      registeredJobId: ctx.jobId || null,
      registeredAt: new Date(),
      kind: input.kind,
      displayName: input.name ?? null,
      roots: [{ key, path: abs }],
    });

    // Rien de rendu ⇒ le dossier était DÉJÀ un projet déclaré (le `setWhere`
    // de l'upsert). On relit la ligne plutôt que de rendre les valeurs
    // demandées : le nom et le kind qui comptent sont ceux de la BASE, pas
    // ceux de cet appel.
    const [row] = await ctx.db
      .select({
        id: codeProjects.id,
        path: codeProjects.projectPath,
        displayName: codeProjects.displayName,
        kind: codeProjects.kind,
      })
      .from(codeProjects)
      .where(and(eq(codeProjects.entityId, ctx.entityId), eq(codeProjects.projectKey, key)))
      .limit(1);
    if (!row) {
      // L'upsert vient d'écrire cette ligne : ne pas la retrouver est une
      // incohérence de base, pas un cas d'usage.
      return { ok: false, reason: 'project_row_missing' };
    }

    // Le rattachement, TOUT DE SUITE. La cible `office_file` ne déclare rien
    // (P5b ne déclare que sur du code), mais la contenance retrouve la ligne
    // qu'on vient d'écrire : le job la porte, et la conversation en fait son
    // projet courant. Sans lui, la conversation resterait sans projet et le
    // tour suivant reposerait la même question.
    const outcome = await attachProductionToProject(
      {
        db: ctx.db,
        entityId: ctx.entityId,
        jobId: ctx.jobId || null,
        conversationId: ctx.conversationId ?? null,
        agentId: ctx.agentId,
        workspaces: ctx.workspaces ?? [],
      },
      [{ kind: 'dir', path: abs, deliverableType: 'office_file' }],
    );
    if (outcome.kind === 'failed') {
      return { ok: false, reason: `attach_failed:${outcome.code}` };
    }

    return {
      ok: true,
      project_id: row.id,
      path: row.path,
      name: row.displayName ?? basename(row.path),
      kind: row.kind === 'documents' ? 'documents' : 'code',
      created: declared.length > 0,
    };
  },
};
