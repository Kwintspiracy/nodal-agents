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
//
// JAMAIS DE REMPLACEMENT SANS `replace: true` (issue #933). Deux jobs de
// rangement lancés en même temps ont posé deux documents sous le même nom, à
// 0,18 s d'écart : les deux appels ont rendu `ok: true`, et l'un des documents
// a disparu. Une règle de compétence (« ajoute (2) ») ne protège pas un
// déplacement, puisqu'elle repose sur une liste du dossier faite AVANT : un
// autre job, un client de synchronisation ou le propriétaire peut créer le nom
// entre les deux. C'est donc l'outil qui garantit, pour tout agent et tout
// appelant, et en un seul geste du système, sans fenêtre entre « le nom est
// libre » et « le fichier est là » :
//   - même volume : un lien physique (`link`), qui échoue en EEXIST quand le
//     nom est pris, puis le retrait de la source ;
//   - deux volumes (EXDEV) : une copie complète dans un fichier temporaire du
//     dossier de destination, posée par le même lien, puis le retrait de la
//     source ;
//   - un volume sans liens physiques (FAT32, exFAT, certains partages) : le
//     nom se RÉSERVE par une création exclusive (O_EXCL), et le fichier
//     complet (la source, ou la copie temporaire) est renommé sur cette
//     réservation vide.
// La destination ne montre donc jamais un fichier à moitié écrit, et un appel
// qui échoue laisse la source en place (`claimName`, `removeSource`).

import { randomBytes } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
        'never replaced unless `replace` is true.',
    ),
  copy: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, copy the file and leave the source in place. Default false: move it.'),
  replace: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, an existing file at the destination is replaced. Default false: when the ' +
        'destination name is taken, nothing moves and the result names the file that is ' +
        'there, so another name can be chosen.',
    ),
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
  | {
      ok: false;
      reason: string;
      /** Le fichier qui occupe déjà la destination, quand c'est la raison du refus (#933). */
      existing?: { path: string; bytes: number; modified: string };
    };

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
  return { ok: true, destination: withSpelledName(resolved, requested) };
}

/**
 * Le nom final tel que l'appel l'écrit. `realpath` rend le nom d'un fichier
 * EXISTANT avec la casse du disque : sur un volume insensible à la casse
 * (Windows, macOS), `scan.pdf` -> `Scan.pdf` résolvait vers `scan.pdf`, la
 * source elle-même, et le renommage était refusé comme « le même fichier ».
 * Seule la casse est reprise de la demande : un nom qui diffère autrement (un
 * lien suivi, un nom court 8.3 développé) est celui que la résolution a trouvé.
 */
function withSpelledName(resolved: string, requested: string): string {
  const spelled = basename(requested);
  const onDisk = basename(resolved);
  return spelled !== onDisk && spelled.toLowerCase() === onDisk.toLowerCase()
    ? join(dirname(resolved), spelled)
    : resolved;
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
 * Une copie COMPLÈTE de `source` dans un fichier temporaire caché du dossier de
 * destination, avec la date de modification de la source : `copyFile` la garde
 * sous Windows, pas partout, et le geste doit être le même sur les trois
 * systèmes. Rend le chemin du temporaire ; le retire si la copie échoue.
 */
async function copyToTemp(source: string, destination: string): Promise<string> {
  const tmp = `${dirname(destination)}/.${basename(destination)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(source, tmp);
    const st = await stat(source);
    await utimes(tmp, st.atime, st.mtime);
    return tmp;
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * `replace: true` — pose `source` à `destination` par une copie : un fichier
 * temporaire du dossier de destination, renommé par-dessus la cible. Une copie
 * interrompue ne laisse jamais une destination à moitié écrite.
 */
async function copyIntoPlace(
  ctx: ToolContext,
  source: string,
  destination: string,
  destroyed: readonly string[],
): Promise<void> {
  const tmp = await copyToTemp(source, destination);
  try {
    await assertStillOurs(ctx, destroyed);
    await rename(tmp, destination);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Ce que `link` répond sur un volume qui n'a pas de liens physiques (FAT32,
 * exFAT, certains partages réseau), ou plus de place pour un lien de plus
 * (EMLINK). Sous Windows, ERROR_INVALID_FUNCTION arrive en EISDIR et
 * ERROR_INVALID_PARAMETER en EINVAL. Un code de cette liste qui voulait dire
 * autre chose (un fichier tenu ailleurs, en EPERM) ne coûte qu'un essai : la
 * réservation exclusive ne remplace rien, et le renommage qui suit échoue sur
 * la même cause.
 */
const NO_HARD_LINK = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EMLINK',
  'EISDIR',
  'EINVAL',
]);

/**
 * Deux états du même fichier : même volume, même numéro. Un numéro nul ne
 * prouve rien : certains partages réseau n'en donnent pas. Sert seulement à
 * reconnaître un renommage de casse ; un retour en arrière ne s'y fie jamais.
 */
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino !== BigInt(0) && a.dev === b.dev && a.ino === b.ino;
}

/**
 * LE RETOUR EN ARRIÈRE NE SE FIE À AUCUN NUMÉRO DE FICHIER (revue A de #938).
 * Un volume qui n'en donne pas (un partage réseau sans index de fichier,
 * justement ceux pour qui la réservation existe) rendait méconnaissable ce que
 * l'appel venait de poser : la réservation restait, et l'appel suivant se
 * refusait devant les restes de l'outil lui-même. Ce que l'appel pose se
 * reconnaît donc par son CONTENU :
 *   - une réservation porte une marque unique, écrite par l'appel : elle est
 *     retirée si elle ne porte que cette marque (ou un début de celle-ci, si
 *     l'écriture a été interrompue) ;
 *   - un fichier posé (un lien ou une copie de la source) est retiré s'il
 *     porte exactement les octets de la source, qui RESTE : rien ne peut s'y
 *     perdre. Un fichier aux octets différents, celui d'un programme qui a
 *     écrasé la destination exprès entre-temps, reste où il est.
 */
const RESERVATION_MARK = 'nodal file_move: this name is reserved, the file arrives now ';

/** Une marque de réservation que nul autre appel ne peut écrire. */
function reservationMark(): Buffer {
  return Buffer.from(`${RESERVATION_MARK}${randomBytes(8).toString('hex')}\n`);
}

/** Taille en octets d'une réservation (sa marque) : ce qu'un autre appel peut voir, le temps d'un renommage. */
export const RESERVATION_BYTES = reservationMark().length;

/** Ce que peut rendre un retrait : fait, refusé (ce n'est pas ce que l'appel a posé), ou l'erreur du système. */
type Removal = 'removed' | 'not_ours' | { error: unknown };

async function unlinkOurs(path: string): Promise<Removal> {
  return unlink(path).then(
    (): Removal => 'removed',
    (error: unknown): Removal => (errnoOf(error) === 'ENOENT' ? 'removed' : { error }),
  );
}

/** Retire la réservation `path` si elle ne porte que la marque `mark` (ou un début). */
async function removeReservation(path: string, mark: Buffer): Promise<Removal> {
  const st = await lstat(path).catch(() => null);
  if (st === null) return 'removed';
  if (!st.isFile() || st.size > mark.length) return 'not_ours';
  const held = await readFile(path).catch(() => null);
  if (held === null || !mark.subarray(0, held.length).equals(held)) return 'not_ours';
  return unlinkOurs(path);
}

/** Les octets des deux fichiers sont-ils les mêmes ? Lus par morceaux : un fichier peut être gros. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstat(a).catch(() => null), lstat(b).catch(() => null)]);
  if (sa === null || sb === null || !sa.isFile() || !sb.isFile() || sa.size !== sb.size) {
    return false;
  }
  const [ha, hb] = await Promise.all([open(a, 'r'), open(b, 'r')]);
  try {
    const [ba, bb] = [Buffer.alloc(1 << 20), Buffer.alloc(1 << 20)];
    for (;;) {
      const [ra, rb] = await Promise.all([
        ha.read(ba, 0, ba.length, null),
        hb.read(bb, 0, bb.length, null),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await Promise.all([ha.close(), hb.close()]);
  }
}

/** Retire `path` s'il porte exactement les octets de `original`, qui reste. */
async function removeCopyOf(path: string, original: string): Promise<Removal> {
  if ((await lstat(path).catch(() => null)) === null) return 'removed';
  return (await sameBytes(path, original).catch(() => false)) ? unlinkOurs(path) : 'not_ours';
}

/**
 * L'erreur d'un appel dont le retour en arrière n'a pas pu retirer ce qu'il
 * avait posé : l'agent l'apprend, avec le chemin (invariant #4).
 */
function withLeftover(err: unknown, path: string, removal: Removal): unknown {
  if (typeof removal === 'string') return err;
  const left = removal.error;
  return Object.assign(
    new Error(
      `${err instanceof Error ? err.message : String(err)}; and what this call had placed at ` +
        `"${path}" could not be removed (${errnoOf(left) ?? 'error'}: ${
          left instanceof Error ? left.message : String(left)
        })`,
    ),
    { code: errnoOf(err) },
  );
}

/**
 * Pose le fichier `from` (sur le volume de la destination) au nom
 * `destination` SANS JAMAIS REMPLACER ce qui s'y trouve, en un seul geste du
 * système : un lien physique, qui échoue en EEXIST quand le nom est pris (`from`
 * reste : l'appelant le retire) ; ou, sur un volume sans liens physiques, une
 * réservation exclusive du nom (O_EXCL, EEXIST aussi), sur laquelle le fichier
 * complet `from` est renommé. La destination ne montre jamais qu'une
 * réservation (sa seule marque), le temps d'un renommage, ou le fichier entier.
 * La seule fenêtre de ce second geste : un programme qui ÉCRASE exprès la
 * réservation entre sa création et le renommage (un `replace: true`, un
 * éditeur) serait écrasé à son tour. Une création ordinaire, elle, trouve le
 * nom pris.
 *
 * Lève l'erreur du système (EEXIST, EXDEV…). Une réservation que l'appel n'a
 * pas pu remplir est retirée, par sa marque, quoi qu'ait échoué après sa
 * création — l'écriture de la marque, la fermeture ou le renommage.
 */
async function claimName(from: string, destination: string): Promise<'linked' | 'renamed'> {
  try {
    await link(from, destination);
    return 'linked';
  } catch (err) {
    if (!NO_HARD_LINK.has(errnoOf(err) ?? '')) throw err;
  }
  const mark = reservationMark();
  const handle = await open(destination, 'wx');
  try {
    try {
      await handle.writeFile(mark);
    } finally {
      await handle.close();
    }
    await rename(from, destination);
    return 'renamed';
  } catch (err) {
    throw withLeftover(err, destination, await removeReservation(destination, mark));
  }
}

/**
 * Pose une copie complète de `source` au nom `destination`, sans jamais
 * remplacer : la copie se fait dans un temporaire du dossier de destination,
 * que `claimName` pose. Aucun temporaire ne reste, que l'appel réussisse ou
 * non.
 */
async function placeCopy(source: string, destination: string): Promise<void> {
  const tmp = await copyToTemp(source, destination);
  try {
    if ((await claimName(tmp, destination)) === 'linked') {
      try {
        await unlink(tmp);
      } catch (err) {
        throw withLeftover(err, destination, await removeCopyOf(destination, source));
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Un déplacement sans remplacement : le fichier est posé à destination
 * (`claimName` sur le même volume, `placeCopy` entre deux volumes), PUIS la
 * source est retirée. Quand elle ne peut pas l'être (un fichier encore ouvert
 * ailleurs), ce que l'appel a posé est retiré à son tour (`removeCopyOf`), et
 * l'erreur remonte : un déplacement qui échoue laisse les choses comme avant.
 * Rend l'erreur du retrait quand ce retour en arrière n'a pas eu lieu : les
 * deux fichiers existent alors, et l'agent doit le savoir.
 */
async function moveWithoutReplacing(source: string, destination: string): Promise<unknown> {
  try {
    if ((await claimName(source, destination)) === 'renamed') return undefined;
  } catch (err) {
    // Deux volumes (un autre disque, un partage monté) : un lien n'y traverse
    // pas, le fichier y arrive par une copie.
    if (errnoOf(err) !== 'EXDEV') throw err;
    await placeCopy(source, destination);
  }
  try {
    await unlink(source);
    return undefined;
  } catch (err) {
    if ((await removeCopyOf(destination, source)) === 'removed') throw err;
    return err;
  }
}

/**
 * Le nom est pris : l'appel échoue, et dit quel fichier est là, pour que
 * l'agent choisisse un autre nom (#933).
 */
async function destinationTaken(
  verb: 'move' | 'copy',
  destination: string,
): Promise<FileMoveOutput> {
  const nothing = verb === 'move' ? 'Nothing was moved' : 'Nothing was copied';
  const rule =
    'file_move never replaces an existing file unless replace:true is passed. Choose ' +
    'another name, or pass replace:true if replacing this file is intended.';
  const there = await lstat(destination).catch(() => null);
  if (there === null) {
    return {
      ok: false,
      reason: `${nothing}: "${destination}" was taken when the call ran. ${rule}`,
    };
  }
  const existing = {
    path: destination,
    bytes: there.size,
    modified: there.mtime.toISOString(),
  };
  return {
    ok: false,
    reason:
      `${nothing}: "${destination}" already exists (${String(existing.bytes)} bytes, ` +
      `modified ${existing.modified}). ${rule}`,
    existing,
  };
}

/** La copie a eu lieu, le retrait de la source non : les DEUX fichiers existent (invariant #4). */
function bothExist(input: FileMoveInput, destination: string, unlinkErr: unknown): FileMoveOutput {
  return {
    ok: false,
    reason:
      `"${input.source}" was copied to "${destination}", but the original could not be ` +
      `removed (${errnoOf(unlinkErr) ?? 'error'}: ${
        unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
      }). Both files exist now.`,
  };
}

/**
 * Les fichiers existants que l'appel DÉTRUIT : la destination, qu'il remplace
 * quand elle existe — seulement avec `replace: true`, sans quoi il ne la
 * remplace jamais (#933) —, et, pour un déplacement, la source, qu'il retire.
 * Retirer du dossier partagé le fichier d'un autre détruit son travail autant
 * que l'écraser : la porte d'écrasement pose donc la même question aux deux.
 * Une copie laisse la source intacte.
 */
function destroyedBy(
  input: Pick<FileMoveInput, 'copy' | 'replace'>,
  paths: { source: string; destination: string },
): string[] {
  const replaced = input.replace === true ? [paths.destination] : [];
  return input.copy ? replaced : [...replaced, paths.source];
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

/**
 * Le geste par défaut (#933) : copier ou déplacer SANS JAMAIS REMPLACER. Un nom
 * pris fait échouer l'appel en nommant le fichier qui est là, sauf quand ce
 * fichier EST la source (même volume, même numéro, une seule entrée) : un
 * renommage qui ne change que la casse, sur un volume insensible à la casse
 * (`scan.pdf` -> `Scan.pdf`). Le renommage renomme alors l'entrée elle-même ;
 * une copie sur soi-même ne fait rien.
 */
async function withoutReplacing(
  ctx: ToolContext,
  input: FileMoveInput,
  source: string,
  destination: string,
  bytes: number,
  destroyed: readonly string[],
): Promise<FileMoveOutput> {
  const verb = input.copy ? 'copy' : 'move';
  await assertStillOurs(ctx, destroyed);
  try {
    if (input.copy) {
      await placeCopy(source, destination);
      return { ok: true, operation: 'copied', source, destination, bytes };
    }
    const left = await moveWithoutReplacing(source, destination);
    if (left !== undefined) return bothExist(input, destination, left);
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    const there = await lstat(destination, { bigint: true }).catch(() => null);
    const self = await stat(source, { bigint: true }).catch(() => null);
    if (there === null || self === null || !sameFile(there, self) || there.nlink !== BigInt(1)) {
      return destinationTaken(verb, destination);
    }
    if (input.copy) {
      return {
        ok: false,
        reason: `Source and destination are the same file: "${input.source}". Nothing to do.`,
      };
    }
    await rename(source, destination);
  }
  // Le déplacement est FAIT : il se confirme maintenant, jamais avant (#916).
  ctx.confirmMove?.(source, destination);
  return { ok: true, operation: 'moved', source, destination, bytes };
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
    'existing file is NEVER replaced: when the destination name is taken, nothing moves and ' +
    'the result names the file that is there (path, size, date), so you can choose another ' +
    'name. Pass replace:true only to replace that file on purpose. A folder as `source` is ' +
    'refused. Use this instead of a shell command to file away a document.',
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
        // La source d'un DÉPLACEMENT déclare où vont ses octets (#916) : son
        // absence après l'appel est attendue, si la destination est un
        // livrable du job. Une copie ne retire rien, et ne déclare rien.
        ...(path === paths.source ? { movesTo: paths.destination } : {}),
      })),
    );
  },
  // La porte d'écrasement de `file_write`, sur chaque fichier que l'appel
  // DÉTRUIT (`destroyedBy`) : un fichier existant du dossier partagé que ce run
  // n'a pas écrit ne se remplace pas, et ne se retire pas, sans personne. Un
  // fichier neuf, ou un dossier de l'agent, ne demande rien : l'instantané le
  // défait.
  computeApproval: async (input, ctx) => {
    let paths: MovePaths;
    try {
      paths = await resolveMove(ctx, input);
    } catch {
      return undefined; // execute() échouera sur la même raison
    }
    if (!paths.ok) return undefined;
    if (await isProtectedWorkflowTemplate(ctx, paths.destination)) return undefined;
    if (!input.copy && (await isProtectedWorkflowTemplate(ctx, paths.source))) return undefined;
    for (const path of destroyedBy(input, paths)) {
      if ((await computeSharedOverwriteApproval(ctx, path)) === 'require_approval') {
        return 'require_approval';
      }
    }
    return undefined;
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
    const destroyed = destroyedBy(input, paths);
    try {
      if (input.create_dirs) await mkdir(dirname(destination), { recursive: true });
      if (input.replace !== true) {
        return await withoutReplacing(ctx, input, source, destination, bytes, destroyed);
      }
      // `replace: true` : le geste d'avant #933, à l'identique.
      if (input.copy) {
        await copyIntoPlace(ctx, source, destination, destroyed);
        return { ok: true, operation: 'copied', source, destination, bytes };
      }
      try {
        await assertStillOurs(ctx, destroyed);
        await rename(source, destination);
        // Le déplacement est FAIT : il se confirme maintenant, jamais avant (#916).
        ctx.confirmMove?.(source, destination);
      } catch (err) {
        // Deux volumes (un autre disque, un partage monté) : un renommage n'y
        // traverse pas. Le déplacement se fait alors en deux temps, copie puis
        // suppression.
        if (errnoOf(err) !== 'EXDEV') throw err;
        await copyIntoPlace(ctx, source, destination, destroyed);
        try {
          await unlink(source);
          // Copié PUIS supprimé : le déplacement est fait (#916).
          ctx.confirmMove?.(source, destination);
        } catch (unlinkErr) {
          // La copie a eu lieu, la suppression non : les DEUX fichiers
          // existent, et l'agent doit le savoir, jamais croire à un
          // déplacement fait (invariant #4).
          return bothExist(input, destination, unlinkErr);
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
