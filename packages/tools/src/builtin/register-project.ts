// Built-in: register_project — la réponse à « où écrire ? » devient un projet
// (P10b, plan « De la maquette au produit »).
//
// LA RÈGLE DE QUENTIN (P5) : « Hors de tout projet, l'agent demande OÙ avant
// d'écrire ; la réponse crée le projet. Rien ne se crée en silence. » Depuis
// P5b, un dossier à MANIFESTE où du code atterrit se déclare tout seul : la
// question ne porte plus que sur les DOCUMENTS — un rapport, une note, un
// classeur — que rien ne permet de ranger.
//
// LE FLUX : `ask_user` (P10a) demande où ranger — les projets déclarés en
// options, plus une option pour le projet neuf que l'agent propose ;
// l'utilisateur choisit ; l'agent appelle CET outil, le propriétaire confirme
// le dossier sur la carte d'approbation, le dossier est créé, déclaré au
// registre, et le job ET la conversation y sont rattachés ; puis l'agent écrit
// dedans, et Spaces montre le projet, son fichier et sa conversation.
//
// CE QUI TIENT LA RÈGLE « rien en silence » : `defaultApproval` ci-dessous.
// Trois tentatives de sauter cette confirmation en lisant la réponse de
// l'utilisateur ont fuité (revues Codex 39, 40, 41) ; la note du champ raconte
// les trois et pourquoi la forme elle-même était mauvaise.
//
// INVARIANT #2 : rien ici ne fabrique de phrase pour l'utilisateur. La sortie
// est une ligne de données ; c'est le LLM qui la raconte.

import { mkdir, rmdir, stat } from 'node:fs/promises';
import { basename } from 'node:path/posix';
import { z } from 'zod';
import { and, eq, codeProjects } from '@nodal-agents/db';
import { isSafeSubfolder, projectKey } from '@nodal-agents/shared';
import type { ToolDefinition } from '../types';
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
    'After this call, write your files under the returned `path`. ' +
    'Creating a project is confirmed by the owner (one approval), unless they granted a ' +
    'standing rule; ask where first with `ask_user`, then call this — the confirmation card ' +
    'shows the folder.',
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
   * LA GARDE « rien ne se crée en silence » : le propriétaire CONFIRME, une fois.
   *
   * TROIS TENTATIVES DE LIAISON, TROIS FUITES (revues Codex 39, 40, 41). L'idée
   * était de laisser passer l'appel quand l'utilisateur avait déjà répondu à
   * une question qui désignait ce projet. Chaque forme a fuité :
   *   - « une question a été répondue dans ce job » : « Quelle couleur ? » →
   *     « Bleu » autorisait `comptabilite` ;
   *   - « l'option choisie CONTIENT le nom » : « Add notes to the README »
   *     autorisait `notes` ;
   *   - « l'option choisie EST le nom » : un projet EXISTANT proposé sous le nom
   *     « Notes » (dossier `existing-notes`), choisi, autorisait
   *     `register_project({ path: 'new-notes', name: 'Notes' })` — les noms
   *     d'affichage ne sont ni uniques ni liés au chemin (seule `project_key`
   *     l'est, voir le schéma).
   *
   * Trois passes sur la même garde : ce n'est pas le réglage qui était mauvais,
   * c'est la FORME. Un texte choisi dans une liste ne désigne pas un chemin. La
   * seule liaison sûre serait une autorisation STRUCTURÉE — l'option porterait
   * l'effet qu'elle autorise, et la résolution produirait une capacité que cet
   * outil consommerait. C'est une migration et une notion neuve, hors de portée
   * de cette pierre.
   *
   * Alors on paie le clic. Créer un projet demande TOUJOURS une confirmation :
   * la carte d'approbation ordinaire montre le dossier, et le propriétaire
   * tranche sur la destination réelle plutôt que sur ce qu'un libellé
   * suggérait. Un clic pour un projet, ce n'est pas cher.
   *
   * CE QUI RELÂCHE LA GARDE, et c'est le propriétaire à chaque fois :
   *   - une règle `auto_approve` EXPLICITE sur cet outil (le toggle par agent) ;
   *   - `fully_autonomous` — cet outil n'est pas un outil d'exécution de code,
   *     donc la relaxation s'applique ;
   *   - `destructive_gate` — il est jugé sur son `riskLevel`, qui est `write`
   *     et non `destructive` : il passe donc aussi (vérifié dans `execute.ts`).
   * Dans les trois cas, quelqu'un a choisi ce régime en connaissance de cause.
   */
  defaultApproval: 'require_approval',
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

    // Le dossier existait-il AVANT cet appel ? Seule réponse qui autorise à le
    // reprendre en cas d'échec plus bas : un dossier que le propriétaire avait
    // déjà ne s'efface pas parce qu'un rattachement a raté (revue Codex,
    // passe 39, constat hors demande).
    const existedBefore = await stat(abs).then(
      (st) => st.isDirectory(),
      () => false,
    );

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
      // DÉFAIRE ce que CET appel a fait, et rien d'autre (revue Codex, passe 39).
      // Sans ce nettoyage, un rattachement raté laissait le projet dans Spaces
      // et le dossier sur le disque, alors que l'appel annonce un échec et que
      // la conversation reste sans projet courant — le pire des deux états.
      //
      // Le dossier ne peut pas entrer dans la transaction SQL : on le retire
      // donc à la main, et seulement si cet appel l'a créé ET qu'il est resté
      // VIDE (`rmdir` échoue sur un dossier peuplé, et c'est la garde qu'on
      // veut : quelque chose y a été écrit entre-temps).

      //
      // ET IL SE DIT (revue Codex, passe 40). Un nettoyage qui échoue en
      // silence laissait l'outil annoncer le seul échec initial, alors que le
      // projet peut encore apparaître dans Spaces : l'agent croyait n'avoir
      // rien créé. La raison rendue distingue donc les deux états.
      let rollbackFailed = false;
      if (declared.length > 0) {
        try {
          await ctx.db.delete(codeProjects).where(eq(codeProjects.id, row.id));
        } catch (err) {
          rollbackFailed = true;
          console.error(
            `[projects] PROJECT_ROLLBACK_ROW_FAILED id=${row.id} key=${key} ` +
              `code=${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
            err,
          );
        }
      }
      if (!existedBefore) {
        try {
          await rmdir(abs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // `ENOTEMPTY` : quelque chose a été écrit dans le dossier entre-temps
          // — le laisser est le bon geste, pas un échec. `ENOENT` : il a déjà
          // disparu, l'état voulu est atteint. Tout le reste (`EACCES`,
          // `EPERM`, une erreur d'E/S) laisse un dossier que cet appel a créé
          // et n'a pas repris : ça se dit (invariant #4).
          if (code !== 'ENOTEMPTY' && code !== 'ENOENT') {
            rollbackFailed = true;
            console.error(
              `[projects] PROJECT_ROLLBACK_DIR_FAILED key=${key} code=${code ?? 'unknown'}`,
              err,
            );
          }
        }
      }
      return {
        ok: false,
        reason: rollbackFailed
          ? `attach_failed:${outcome.code};rollback_failed`
          : `attach_failed:${outcome.code}`,
      };
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
