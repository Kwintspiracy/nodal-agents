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
// ne suffit pas qu'une question ait été répondue dans ce job — il faut que
// l'option CHOISIE nomme CE projet. Sinon, la création passe par la carte
// d'approbation ordinaire.
//
// INVARIANT #2 : rien ici ne fabrique de phrase pour l'utilisateur. La sortie
// est une ligne de données ; c'est le LLM qui la raconte.

import { mkdir, rmdir, stat } from 'node:fs/promises';
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

/** Combien de questions répondues du job la garde examine au plus. */
const ANSWERED_QUESTIONS_SCANNED = 50;

/**
 * Le repli de comparaison : diacritiques retirés, minuscules, espaces rognés.
 *
 * `NFKD` sépare la lettre de son accent, la plage `\u0300-\u036f` retire les
 * accents ainsi détachés. « Été 2026 » et « ete 2026 » deviennent le même
 * texte, ce qui compte parce que l'agent écrit le libellé de l'option d'un
 * côté et le nom du projet de l'autre, à deux appels d'écart.
 */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Le dernier segment d'un chemin d'entrée — le nom du dossier demandé. */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((s) => s !== '');
  return parts[parts.length - 1] ?? '';
}

/**
 * L'utilisateur a-t-il, dans CE job, choisi une option qui NOMME ce projet ?
 *
 * POURQUOI CETTE RÈGLE, et pas « une question a été répondue » (revue Codex,
 * passe 39, constat bloquant). L'ancienne version se contentait d'une ligne
 * `kind = 'question'` approuvée dans le job : « Quelle couleur ? » → « Bleu »
 * suffisait alors à créer `comptabilite` sans que personne n'ait rien dit de
 * cette destination. « Le propriétaire a été consulté » n'est pas
 * « le propriétaire a autorisé CE projet ».
 *
 * POURQUOI PAS une table d'autorisations. Codex proposait qu'`ask_user` porte
 * les effets de chaque option, ou qu'une ligne
 * `project_registration_authorizations` soit produite à la résolution et
 * consommée ici. Les deux demandent une migration et une notion de capacité
 * consommable que rien d'autre du produit n'utilise. La liaison existe déjà,
 * sans rien ajouter : c'est l'AGENT qui écrit le libellé de l'option
 * (« New project: veille-ia ») et l'AGENT qui écrit ensuite le `name`/`path`.
 * Exiger que le libellé CHOISI contienne l'un des deux lie la réponse à la
 * destination sans lire la prose de la question, et sans qu'un texte libre
 * puisse s'y substituer : le libellé n'est pas saisi par l'utilisateur, il est
 * choisi parmi ceux que l'agent a proposés (la résolution refuse toute réponse
 * hors options, voir `ask-user.ts`).
 *
 * `approved` seulement : une question DÉCLINÉE n'est pas une réponse.
 *
 * Aucune correspondance ⇒ la carte d'approbation ORDINAIRE, jamais un refus :
 * l'agent a peut-être raison, c'est au propriétaire de trancher.
 */
async function jobAnsweredForProject(
  db: ToolContext['db'],
  jobId: string,
  wanted: { name?: string | undefined; folder: string },
): Promise<boolean> {
  if (!jobId) return false;
  // Les aiguilles vides sont écartées : `''.includes` serait toujours vrai, et
  // rendrait la garde inopérante sur un `name` blanc.
  const needles = [wanted.name, wanted.folder]
    .map((v) => (v === undefined ? '' : fold(v)))
    .filter((v) => v !== '');
  if (needles.length === 0) return false;

  const rows = await db
    .select({ answer: approvalRequests.answer })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.jobId, jobId),
        eq(approvalRequests.kind, 'question'),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .limit(ANSWERED_QUESTIONS_SCANNED);

  return rows.some((r) => {
    if (!r.answer) return false;
    const answer = fold(r.answer);
    return needles.some((n) => answer.includes(n));
  });
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
    'After this call, write your files under the returned `path`. ' +
    'One rule to know: this runs without a second prompt only when the option the person ' +
    'picked in your question names this very project — its `name` or its folder. That is ' +
    'what a "New project: veille-ia" option does. Ask with that label, then reuse it here; ' +
    'otherwise the owner is asked to confirm the folder before anything is created.',
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
   * Sans réponse qui NOMME ce projet dans ce job, créer un projet passe par la
   * carte d'approbation ORDINAIRE : le propriétaire voit le dossier proposé et
   * tranche. Avec une telle réponse, il a DÉJÀ tranché sur CETTE destination —
   * redemander transformerait son choix en deux clics pour une seule décision.
   * La règle exacte, et pourquoi elle ne lit pas la prose de la question, est
   * dans `jobAnsweredForProject`.
   *
   * Pas de `defaultApproval` : une règle explicite du propriétaire (un
   * `auto_approve` posé sur cet outil, ou un `block`) garde la précédence,
   * comme pour `file_write`. Et sous `fully_autonomous` le hook n'est même pas
   * appelé — c'est le choix explicite du propriétaire, la même mécanique que
   * l'écrasement gaté de `file_write`, pas un contournement.
   */
  computeApproval: async (input, ctx) =>
    (await jobAnsweredForProject(ctx.db, ctx.jobId, {
      name: input.name,
      folder: lastSegment(input.path),
    }))
      ? undefined
      : 'require_approval',
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
      if (declared.length > 0) {
        await ctx.db
          .delete(codeProjects)
          .where(eq(codeProjects.id, row.id))
          .catch((err: unknown) => {
            console.error(`[projects] PROJECT_ROLLBACK_FAILED id=${row.id}`, err);
          });
      }
      if (!existedBefore) {
        await rmdir(abs).catch(() => undefined);
      }
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
