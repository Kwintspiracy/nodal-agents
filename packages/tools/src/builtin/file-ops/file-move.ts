// file-ops/file-move.ts — déplacer ou copier UN fichier entre les dossiers de
// l'agent (issue #879).
//
// Un fichier reçu (un scan, un téléchargement, un export) se rangeait par
// `run_command` (`move` / `mv`) : la liste des commandes permises, le périmètre
// d'écriture du bac à sable et, souvent, une approbation, pour un geste qui
// n'écrit rien de neuf. Et copier un binaire était impossible : `file_write`
// écrit du texte.
//
// LE PÉRIMÈTRE EST CELUI DE `file_write`, des deux côtés. La source et la
// destination se résolvent par `resolveAndCheckPath` (libellé ou chemin
// absolu, liens qui sortent refusés) : les dossiers de l'agent et `shared`,
// rien d'autre. Les dossiers permis du bac à sable gouvernent les COMMANDES,
// pas cet outil.
//
// LES OCTETS NE PASSENT JAMAIS PAR LE MODÈLE. L'outil renomme ou copie sur le
// disque ; le résultat ne porte que les deux chemins et la taille. N'importe
// quel type de fichier, donc, et aucune limite de taille autre que celle du
// disque.
//
// LE RETOUR EN ARRIÈRE est celui de tout outil qui écrit : `mutatesWorkspace`
// fait prendre par le seam (`takeCheckpointForTurn`) l'instantané de CHAQUE
// dossier de l'agent avant l'appel, une fois par tour. Un déplacement d'un
// dossier à l'autre est donc couvert des deux côtés.
//
// LE CONSTAT est celui de `file_write` : les deux chemins sont des cibles
// FICHIER (`resolveMutationTargets`), photographiées avant et relues après par
// le seam, qui range la destination créée et la source retirée. L'outil ne
// rapporte AUCUNE empreinte écrite (`reportWrittenContent`) : il n'a pas
// produit ces octets, il les a déplacés. Le fichier arrivé dans `shared` n'est
// donc pas « du contenu que ce run a écrit », et la porte d'écrasement le
// protège comme le travail d'un autre — le choix prudent.

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';
import { failureText, filesCard } from '../../presenters';
import { deliverableTypeForWrittenFile } from '../../verification/written-file-type';
import {
  resolveAndCheckPath,
  computeSharedOverwriteApproval,
  isProtectedWorkflowTemplate,
  WORKFLOW_TEMPLATE_PROTECTED_MESSAGE,
  WorkspaceError,
} from './workspace';

export const FileMoveInputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'The file to move or copy, relative to the workspace root (or "<label>/<path>"), or an ' +
        'absolute path inside a workspace. One file: a folder is refused.',
    ),
  destination: z
    .string()
    .min(1)
    .describe(
      'Where the file goes: a file path, or an existing folder (the file keeps its name ' +
        'there). End it with "/" to name a folder. An existing file at the destination is ' +
        'replaced.',
    ),
  copy: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, copy the file and leave the source in place. Default false: move it.'),
  create_dirs: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, create missing folders at the destination.'),
  purpose: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. One short sentence on WHY this move is needed. Shown first on the approval ' +
        'card when this call requires human review (e.g. replacing an existing file in the ' +
        'shared workspace): say why in plain language, not what `source` and `destination` ' +
        'already say.',
    ),
});

export type FileMoveInput = z.infer<typeof FileMoveInputSchema>;
export type FileMoveOutput =
  | {
      ok: true;
      operation: 'moved' | 'copied';
      /** Le chemin résolu de la source. */
      source: string;
      /** Le chemin résolu où le fichier se trouve maintenant. */
      destination: string;
      bytes: number;
    }
  | { ok: false; reason: string };

/** Les deux chemins RÉSOLUS d'un appel, ou la raison pour laquelle il ne peut pas avoir lieu. */
type MovePaths =
  | { ok: true; source: string; destination: string; bytes: number }
  | { ok: false; reason: string };

/** Un code d'erreur du système, quand l'erreur en porte un. */
function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Où va le fichier : la destination telle que nommée, ou, quand elle désigne
 * un dossier (existant, ou terminé par un séparateur), ce dossier suivi du nom
 * de la source.
 *
 * Le nom est raccroché au chemin DEMANDÉ, pas au chemin résolu : il repasse
 * ainsi par `resolveAndCheckPath` comme n'importe quel chemin de l'agent, et
 * un libellé (`archive/`) reste un libellé.
 */
async function resolveDestination(
  ctx: Pick<ToolContext, 'workspaces'>,
  requested: string,
  sourceName: string,
): Promise<{ ok: true; destination: string } | { ok: false; reason: string }> {
  const namesFolder = /[\\/]$/.test(requested);
  const resolved = await resolveAndCheckPath(ctx, requested);
  const existing = await stat(resolved).catch(() => null);
  if (existing?.isDirectory() || (namesFolder && existing === null)) {
    const inFolder = `${requested.replace(/[\\/]+$/, '')}/${sourceName}`;
    return { ok: true, destination: await resolveAndCheckPath(ctx, inFolder) };
  }
  if (namesFolder) {
    return {
      ok: false,
      reason: `Destination "${requested}" ends with "/" but is a file, not a folder.`,
    };
  }
  return { ok: true, destination: resolved };
}

/**
 * La résolution d'un appel, faite à l'identique par le hook d'intention, la
 * porte d'approbation et l'exécution : le même chemin des trois côtés.
 * Lève `WorkspaceError` sur un chemin hors périmètre.
 */
async function resolveMove(
  ctx: Pick<ToolContext, 'workspaces'>,
  input: Pick<FileMoveInput, 'source' | 'destination'>,
): Promise<MovePaths> {
  const source = await resolveAndCheckPath(ctx, input.source);
  const st = await stat(source).catch((err: unknown) => {
    if (errnoOf(err) === 'ENOENT') return null;
    throw err;
  });
  if (st === null) return { ok: false, reason: `File not found: "${input.source}".` };
  if (st.isDirectory()) {
    return {
      ok: false,
      reason:
        `"${input.source}" is a folder. This tool moves or copies one file at a time: ` +
        'call it for each file the folder holds.',
    };
  }
  if (!st.isFile()) {
    return { ok: false, reason: `"${input.source}" is not a regular file.` };
  }
  const dest = await resolveDestination(ctx, input.destination, basename(source));
  if (!dest.ok) return dest;
  if (dest.destination === source) {
    return {
      ok: false,
      reason: `Source and destination are the same file: "${input.source}". Nothing to do.`,
    };
  }
  return { ok: true, source, destination: dest.destination, bytes: st.size };
}

/**
 * La raison d'un échec du système, dite à l'agent avec ce qu'il peut y faire.
 * Un fichier ouvert par un autre programme (encore en écriture, typiquement)
 * se refuse sous Windows avec EBUSY ou EPERM : l'agent doit l'apprendre, pas
 * lire une erreur brute.
 */
function systemFailure(err: unknown, verb: 'move' | 'copy', input: FileMoveInput): string {
  const code = errnoOf(err) ?? 'error';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return (
      `Could not ${verb} "${input.source}" to "${input.destination}" (${code}: ${message}). ` +
      'The file may be open in another program, still being written, or read-only. ' +
      'Call again once it is complete and closed.'
    );
  }
  return `Could not ${verb} "${input.source}" to "${input.destination}" (${code}: ${message}).`;
}

/**
 * Pose `source` à `destination` par une copie : un fichier temporaire du
 * dossier de destination, renommé par-dessus la cible. Une copie interrompue
 * ne laisse jamais une destination à moitié écrite.
 */
async function copyIntoPlace(
  ctx: ToolContext,
  source: string,
  destination: string,
  destroyed: readonly string[],
): Promise<void> {
  const tmp = `${dirname(destination)}/.${basename(destination)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(source, tmp);
    await assertStillOurs(ctx, destroyed);
    await rename(tmp, destination);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Les fichiers existants que l'appel DÉTRUIT : la destination, qu'il remplace
 * quand elle existe, et, pour un déplacement, la source, qu'il retire. Retirer
 * du dossier partagé le fichier d'un autre détruit son travail autant que
 * l'écraser : la porte d'écrasement pose donc la même question aux deux. Une
 * copie laisse la source intacte.
 */
function destroyedBy(copy: boolean, paths: { source: string; destination: string }): string[] {
  return copy ? [paths.destination] : [paths.destination, paths.source];
}

/**
 * La dernière question de la porte d'écrasement, reposée juste avant de
 * toucher aux fichiers — la même que `writeFileAtomically` pose (#505) :
 * quand la porte a laissé passer l'appel sans personne, un fichier qui a
 * changé depuis n'est ni remplacé ni retiré.
 */
async function assertStillOurs(ctx: ToolContext, destroyed: readonly string[]): Promise<void> {
  if (ctx.sharedOverwriteUnattended !== true) return;
  for (const path of destroyed) {
    if ((await computeSharedOverwriteApproval(ctx, path)) === 'require_approval') {
      throw new WorkspaceError(
        'shared_file_changed',
        `Nothing was moved: "${basename(path)}" in the shared folder changed since this ` +
          'call was allowed, and it is no longer content this run wrote. Call again: the owner ' +
          'will be asked first.',
      );
    }
  }
}

export const fileMoveTool: ToolDefinition<typeof FileMoveInputSchema, FileMoveOutput> = {
  name: 'file_move',
  label: 'Move or copy a workspace file',
  summary:
    'Move a file to another place in the agent’s folders, or copy it there. Works for any type of file, which is never read.',
  description:
    'Move (or, with copy:true, copy) ONE file inside the agent workspaces: rename it, file it ' +
    'into another folder, or carry it from one workspace to another. Works on any file type ' +
    '(images, PDFs, archives): the content is never read nor returned. `destination` is a ' +
    'file path, or a folder (existing, or ending with "/") where the file keeps its name. An ' +
    'existing file at the destination is replaced. A folder as `source` is refused. Use this ' +
    'instead of a shell command to file away a document.',
  inputSchema: FileMoveInputSchema,
  riskLevel: 'write',
  egress: 'none',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? filesCard([
          {
            path: output.destination,
            action: output.operation,
            from: output.source,
            bytes: output.bytes,
          },
        ])
      : failureText(output.reason),
  mutatesWorkspace: true,
  // Les DEUX fichiers que l'appel touche : la destination, qu'il crée ou
  // remplace, et, pour un déplacement, la source, qu'il retire. Le seam les
  // photographie avant et les relit après, comme la cible d'un `file_write` :
  // c'est ce qui range « destination créée, source retirée ».
  //
  // Comme `file_write`, la `catch` ne couvre QUE la résolution (issue #211) :
  // aucun fichier ne bougera, `execute` échouera sur la même raison.
  resolveMutationTargets: async (input, ctx) => {
    let paths: MovePaths;
    try {
      paths = await resolveMove(ctx, input);
    } catch {
      return [];
    }
    if (!paths.ok) return [];
    const touched = input.copy ? [paths.destination] : [paths.destination, paths.source];
    return Promise.all(
      touched.map(async (path) => ({
        kind: 'file' as const,
        path,
        deliverableType: await deliverableTypeForWrittenFile(ctx, path),
      })),
    );
  },
  // La porte d'écrasement de `file_write`, sur chaque fichier que l'appel
  // DÉTRUIT (`destroyedBy`) : un fichier existant du dossier partagé que ce run
  // n'a pas écrit ne se remplace pas, et ne se retire pas, sans personne. Un
  // fichier neuf, ou un dossier de l'agent, ne demande rien : l'instantané le
  // défait.
  replacesSharedFile: async (input, ctx) => {
    let paths: MovePaths;
    try {
      paths = await resolveMove(ctx, input);
    } catch {
      return false; // execute() échouera sur la même raison
    }
    if (!paths.ok) return false;
    if (await isProtectedWorkflowTemplate(ctx, paths.destination)) return false;
    if (!input.copy && (await isProtectedWorkflowTemplate(ctx, paths.source))) return false;
    for (const path of destroyedBy(input.copy, paths)) {
      if ((await computeSharedOverwriteApproval(ctx, path)) === 'require_approval') {
        return true;
      }
    }
    return false;
  },
  execute: async (input, ctx) => {
    let paths: MovePaths;
    try {
      paths = await resolveMove(ctx, input);
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      throw err;
    }
    if (!paths.ok) return paths;
    const { source, destination, bytes } = paths;
    // P4 — un modèle de workflow partagé est en lecture seule pour les outils
    // fichier : rien ne s'écrit dessus, et un déplacement ne l'emporte pas.
    // Le copier ailleurs reste une lecture.
    if (
      (await isProtectedWorkflowTemplate(ctx, destination)) ||
      (!input.copy && (await isProtectedWorkflowTemplate(ctx, source)))
    ) {
      return { ok: false, reason: WORKFLOW_TEMPLATE_PROTECTED_MESSAGE };
    }
    const verb = input.copy ? 'copy' : 'move';
    const destroyed = destroyedBy(input.copy, paths);
    try {
      if (input.create_dirs) await mkdir(dirname(destination), { recursive: true });
      if (input.copy) {
        await copyIntoPlace(ctx, source, destination, destroyed);
        return { ok: true, operation: 'copied', source, destination, bytes };
      }
      try {
        await assertStillOurs(ctx, destroyed);
        await rename(source, destination);
      } catch (err) {
        // Deux volumes (un autre disque, un partage monté) : un renommage n'y
        // traverse pas. Le déplacement se fait alors en deux temps, copie puis
        // suppression.
        if (errnoOf(err) !== 'EXDEV') throw err;
        await copyIntoPlace(ctx, source, destination, destroyed);
        try {
          await unlink(source);
        } catch (unlinkErr) {
          // La copie a eu lieu, la suppression non : les DEUX fichiers
          // existent, et l'agent doit le savoir, jamais croire à un
          // déplacement fait (invariant #4).
          return {
            ok: false,
            reason:
              `"${input.source}" was copied to "${destination}", but the original could not be ` +
              `removed (${errnoOf(unlinkErr) ?? 'error'}: ${
                unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
              }). Both files exist now.`,
          };
        }
      }
      return { ok: true, operation: 'moved', source, destination, bytes };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      if (errnoOf(err) === 'ENOENT') {
        const parent = await stat(dirname(destination)).catch(() => null);
        if (parent === null) {
          return {
            ok: false,
            reason: `Parent directory does not exist for "${input.destination}". Pass create_dirs:true to create it.`,
          };
        }
        return { ok: false, reason: `File not found: "${input.source}". It may have just moved.` };
      }
      return { ok: false, reason: systemFailure(err, verb, input) };
    }
  },
};
