// channels/inbound-files.ts — les fichiers qu'une personne envoie à un agent
// par un canal de messagerie, quel que soit le canal (#899).
//
// Le 31/10, un PDF envoyé sur Telegram avec « Range moi ça » a donné un job dont
// le message était la légende seule : le handler ne lisait que `photo`, et un
// document, un audio, une vidéo disparaissaient sans que personne le sache
// (invariant #4). Chaque canal portait sa propre copie de « télécharger une
// image, l'écrire, l'attacher au job » (Telegram, Discord), et aucun ne savait
// faire autre chose qu'une image.
//
// UNE réception pour tous les canaux. Un canal ne fait que traduire son API en
// une liste de `InboundFile` (un nom, un type, une taille, et de quoi obtenir les
// octets) ; ici, chaque fichier :
//   - est rangé dans le dossier partagé de l'espace, un dossier par job sous
//     son canal : <shared>/<canal>/<jobId>/<nom d'origine>. Le nom d'origine
//     est gardé (nettoyé pour Windows, macOS et Linux), jamais écrasé (suffixe
//     « (2) » si le nom existe déjà). Le dossier du job porte la clé que lisent
//     les deux ménages (`pruneInboundFolder` ici, `pruneJobMediaFiles` du
//     cron) : sans lui, un nom d'origine ne dirait plus à quel job il est.
//     Le chemin ne porte AUCUNE adresse de canal (#910) : la frontière vers le
//     modèle (`addressedByHandle`) remplace chaque identifiant de conversation
//     connu par son handle dans tout ce que le modèle lit, et les entrées des
//     outils ne sont pas relues. Un chemin <shared>/telegram/<chat id>/… lui
//     était donc montré `…/conv_<handle>/…`, un chemin qui n'existe pas : trois
//     `file_read` en « File not found » au premier PDF du propriétaire. Le
//     jobId, lui, est un identifiant de Nodal qu'aucune frontière ne réécrit.
//     Le NOM aussi passe la frontière : un fichier que la personne a nommé
//     d'après une adresse connue (`4242.pdf` dans le chat 4242) est écrit sous
//     le nom que le modèle lira (`conv_<handle>.pdf`, `asTheModelReadsIt`) ;
//   - n'est jamais supprimé avant le délai que sa note promet au modèle
//     (30 jours) : le ménage ne retire que par l'âge. Une conversation qui a
//     déjà 200 fichiers reçus non déplacés dans ce délai voit les suivants
//     refusés, et c'est dit (une partie « NOT received » qui dit pourquoi),
//     jamais un fichier promis effacé à leur place (revue de #911) ;
//   - devient UNE partie texte du premier message du job, pour l'agent : son
//     chemin pour les outils fichiers (`shared/…`) et son chemin absolu (un
//     runtime CLI n'a que lui), son nom, son type, sa taille ;
//   - garde en plus sa partie image quand ses octets sont une image qu'un modèle
//     prend (`{ type: 'image', image: <file: URL> }`), que `hydrateForLlm`
//     change en octets au moment de l'appel, quel que soit le nom du fichier ;
//   - ou, quand il n'a pas pu être obtenu ou écrit (trop gros pour le canal,
//     réseau, délai), devient une partie texte qui dit lequel et pourquoi :
//     l'agent le dit dans sa réponse. Jamais abandonné.
//
// Le texte de ces parties s'adresse au MODÈLE, comme les notes d'image de
// job/model-images.ts : il n'est pas montré à la personne par le runner.

import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, conversationIdsAsHandles, eq, inArray } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import { isConversationHandle } from '@nodal-agents/shared';
import {
  MODEL_IMAGE_MEDIA_TYPES,
  SHARED_WORKSPACE_LABEL,
  formatBytes,
  sniffImageMediaType,
  windowsDeviceName,
  workspacesRoot,
} from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';
import { TERMINAL_STATUSES } from '../job/state.ts';
import { stripUnsafeNameChars } from './shared.ts';

/** Un fichier d'un message entrant, tel que son canal le décrit. */
export interface InboundFile {
  /** Le nom du fichier chez la personne ; `null` quand le canal n'en donne pas (une photo Telegram). */
  readonly name: string | null;
  /** Le type que le canal déclare ; `null` quand il n'en déclare pas. */
  readonly mediaType: string | null;
  /** La taille que le canal déclare, en octets ; `null` quand il ne la donne pas. */
  readonly size: number | null;
  /** Les octets. Lève une erreur dont le message dit pourquoi le fichier n'a pas pu être obtenu. */
  readonly download: () => Promise<Uint8Array>;
}

/** Ce que la réception a fait d'un fichier. */
export type InboundFileOutcome =
  | {
      readonly received: true;
      readonly name: string;
      readonly mediaType: string | null;
      readonly size: number;
      /** Le chemin absolu du fichier écrit. */
      readonly path: string;
      /** Le même, tel que les outils fichiers de l'agent l'acceptent (`shared/…`). */
      readonly workspacePath: string;
    }
  | {
      readonly received: false;
      readonly name: string;
      readonly mediaType: string | null;
      readonly size: number | null;
      readonly reason: string;
    };

/**
 * Le dossier d'arrivée d'un canal sous le dossier partagé : <shared>/<canal>.
 * Il ne prend pas d'adresse de conversation, et c'est voulu (#910) : ce qui
 * est rangé sous lui est nommé au modèle, qui doit pouvoir le retaper tel quel.
 */
export function inboundFolder(entityId: string, channel: string): string {
  return join(workspacesRoot(), entityId, 'shared', safePathSegment(channel));
}

/**
 * La tâche d'un message qui ne porte qu'un fichier, sans un mot : le job naît
 * quand même, avec une tâche neutre. Une image garde la phrase des photos
 * d'avant (Telegram, Discord) ; tout autre fichier a la sienne.
 */
export function captionlessTask(files: readonly Pick<InboundFile, 'mediaType'>[]): string {
  const allImages = files.every((f) => (f.mediaType ?? '').startsWith('image/'));
  return allImages ? 'Image envoyée (sans légende).' : 'Fichier envoyé (sans légende).';
}

/**
 * Reçoit les fichiers d'un message entrant et les met dans le premier message
 * du job `jobId` : le texte de la personne, puis une partie par fichier.
 *
 * Appelée APRÈS la transaction qui a créé le job (le téléchargement est du
 * réseau, il ne tient pas dans une transaction) et AVANT que le worker parte.
 * L'écriture du message est conditionnée à `status = 'pending'` (G1) : si le
 * job a déjà été pris pendant le téléchargement, son fil en cours n'est pas
 * écrasé, et c'est dit fort dans les journaux, chemins compris — jamais en
 * silence (invariant #4).
 *
 * Un fichier qui n'a pas pu être obtenu ou écrit ne fait pas échouer les
 * autres : il devient sa phrase. De même un fichier pour lequel la
 * conversation n'a plus de place (`inboundRoom`). Seule l'écriture en base
 * peut lever.
 */
export async function receiveInboundFiles(args: {
  db: RunnerDeps['db'];
  jobId: string;
  entityId: string;
  channel: string;
  /** Le texte du message de la personne, tel que le job le porte déjà. */
  text: string;
  files: readonly InboundFile[];
}): Promise<{ attached: boolean; outcomes: InboundFileOutcome[] }> {
  const { db, jobId, entityId, channel, text, files } = args;
  const folder = inboundFolder(entityId, channel);
  const jobFolder = join(folder, jobId);
  const workspaceFolder = [SHARED_WORKSPACE_LABEL, safePathSegment(channel), jobId].join('/');
  const inbox = `${SHARED_WORKSPACE_LABEL}/${safePathSegment(channel)}/`;

  // La place de la conversation, AVANT tout téléchargement : le ménage par
  // l'âge d'abord, puis le compte de ce qu'elle y a encore. Une place qui n'a
  // pas pu être lue n'est pas supposée : les fichiers ne sont pas reçus, et
  // c'est dit (invariant #4).
  let room: number;
  let noRoomReason: string;
  try {
    room = await inboundRoom(folder, db, jobId);
    noRoomReason =
      `this conversation already has ${INBOUND_FOLDER_MAX_ENTRIES} received files under ` +
      `${inbox} from the last ${KEPT_DAYS} days that were not moved; moving or deleting ` +
      'some of them makes room';
  } catch (err) {
    room = 0;
    noRoomReason = `the folder ${inbox} could not be checked: ${errorText(err)}`;
  }

  const outcomes: InboundFileOutcome[] = [];
  const parts: unknown[] = [{ type: 'text', text }];
  for (const file of files) {
    const shownName = displayName(file);
    if (room <= 0) {
      const outcome = failed(file, shownName, noRoomReason);
      outcomes.push(outcome);
      parts.push({ type: 'text', text: notReceivedNote(outcome) });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await file.download();
    } catch (err) {
      const outcome = failed(file, shownName, errorText(err));
      outcomes.push(outcome);
      parts.push({ type: 'text', text: notReceivedNote(outcome) });
      continue;
    }
    const sniffed = sniffImageMediaType(bytes.subarray(0, 16));
    const mediaType = sniffed ?? file.mediaType;
    let saved: { path: string; name: string };
    try {
      await mkdir(jobFolder, { recursive: true });
      const name = await asTheModelReadsIt(db, entityId, safeFileName(file.name, mediaType));
      saved = await writeUnique(jobFolder, name, bytes);
    } catch (err) {
      const outcome = failed(file, shownName, `it could not be saved: ${errorText(err)}`);
      outcomes.push(outcome);
      parts.push({ type: 'text', text: notReceivedNote(outcome) });
      continue;
    }
    room -= 1;
    const outcome: InboundFileOutcome = {
      received: true,
      name: shownName,
      mediaType,
      size: bytes.byteLength,
      path: saved.path,
      workspacePath: `${workspaceFolder}/${saved.name}`,
    };
    outcomes.push(outcome);
    parts.push({ type: 'text', text: receivedNote(outcome, workspaceFolder) });
    if (mediaType !== null && MODEL_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      // Un `file:` URL, jamais le chemin nu : `hydrateForLlm` lit une URL sans
      // rien deviner, alors qu'un chemin nu n'y est reconnu qu'à son extension
      // (`capture.20261031` n'en a pas une qu'il connaisse, et `C:` y passe
      // pour un schéma d'URL). Revue de #902.
      parts.push({ type: 'image', image: pathToFileURL(saved.path).href });
    }
  }

  const attached = await db
    .update(agentJobs)
    .set({ messages: [{ role: 'user', content: parts }] })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'pending')))
    .returning({ id: agentJobs.id });

  if (attached.length === 0) {
    const where = outcomes
      .map((o) => (o.received ? o.path : `${JSON.stringify(o.name)} (not received)`))
      .join(', ');
    console.warn(
      `[${channel}] inbound files for job ${jobId} arrived after the job left 'pending' ` +
        `(claimed/worker started); not attached to the transcript: ${where}.`,
    );
  }

  return { attached: attached.length > 0, outcomes };
}

// ─── Les phrases pour le modèle ───────────────────────────────────────────────

function describe(name: string, mediaType: string | null, size: number | null): string {
  const facts = [mediaType ?? 'type unknown', size === null ? 'size unknown' : formatBytes(size)];
  return `${JSON.stringify(name)} (${facts.join(', ')})`;
}

function receivedNote(
  o: Extract<InboundFileOutcome, { received: true }>,
  workspaceFolder: string,
): string {
  const inbox = workspaceFolder.slice(0, workspaceFolder.lastIndexOf('/') + 1);
  return (
    `[File sent with this message: ${describe(o.name, o.mediaType, o.size)}. ` +
    `Saved at ${o.workspacePath} for the file tools (absolute path: ${o.path}). ` +
    `Files left under ${inbox} are deleted after ${KEPT_DAYS} days: move it to keep it.]`
  );
}

function notReceivedNote(o: Extract<InboundFileOutcome, { received: false }>): string {
  return (
    `[A file sent with this message was NOT received: ${describe(o.name, o.mediaType, o.size)}. ` +
    `Reason: ${o.reason}. Tell the user it did not arrive.]`
  );
}

function failed(
  file: InboundFile,
  name: string,
  reason: string,
): Extract<InboundFileOutcome, { received: false }> {
  return { received: false, name, mediaType: file.mediaType, size: file.size, reason };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Le nom à dire à l'agent : celui de la personne, ou, s'il n'y en a pas, celui que le fichier aura. */
function displayName(file: InboundFile): string {
  const raw = file.name === null ? '' : stripUnsafeNameChars(file.name).trim();
  return raw === '' ? safeFileName(null, file.mediaType) : raw;
}

// ─── Les noms de fichiers ─────────────────────────────────────────────────────

/** Octets UTF-8 au plus pour un nom : sous les 255 de ext4, APFS et NTFS, avec de la marge pour le chemin. */
const MAX_NAME_BYTES = 150;

/**
 * Un nom que Windows prend pour un périphérique (`CON`, `nul.txt`, `con .txt`,
 * `COM1.pdf`…) reçoit un `_` devant. La règle est celle des outils fichiers
 * (`windowsDeviceName`), appliquée sur TOUS les systèmes : un fichier du
 * dossier partagé doit rester lisible par un runner Windows, et sous Windows
 * une écriture vers `con .txt` part dans la console — aucun octet sur le
 * disque (revue de #902).
 */
function notADevice(name: string): string {
  return windowsDeviceName(name) === null ? name : `_${name}`;
}

/** L'extension d'un type, pour un nom qui n'en a pas. */
const EXTENSION_OF_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
};

function fallbackStem(mediaType: string | null): string {
  const top = (mediaType ?? '').split('/')[0];
  if (top === 'image' || top === 'audio' || top === 'video') return top;
  return 'file';
}

function hasExtension(name: string): boolean {
  return /[^.]\.[A-Za-z0-9]{1,10}$/.test(name);
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** `s` coupé à `max` octets UTF-8, sans couper un caractère. */
function cutToBytes(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (utf8Length(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** Les caractères qu'un des trois systèmes refuse dans un nom, et les espaces/points de fin que Windows retire. */
function cleanSegment(raw: string): string {
  return stripUnsafeNameChars(raw.normalize('NFC'))
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
}

/** Un segment de chemin sûr (un nom de canal). */
function safePathSegment(raw: string): string {
  const cleaned = cutToBytes(cleanSegment(raw), MAX_NAME_BYTES);
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '_';
  return notADevice(cleaned);
}

/**
 * Le nom sous lequel un fichier reçu est écrit : le nom d'origine, valable
 * sous Windows, macOS et Linux. Seul le dernier segment compte (un nom ne
 * remonte jamais l'arborescence) ; les caractères interdits deviennent `_` ; un
 * nom réservé par Windows est préfixé ; un nom trop long est coupé en gardant
 * son extension ; un nom sans extension reçoit celle de son type quand on la
 * connaît ; un nom vide prend celui de son type (`image.jpg`, `file`).
 */
export function safeFileName(raw: string | null, mediaType: string | null): string {
  const last = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let name = cleanSegment(last);
  if (name === '' || /^\.+$/.test(name)) name = fallbackStem(mediaType);
  if (!hasExtension(name)) {
    const ext = mediaType === null ? undefined : EXTENSION_OF_TYPE[mediaType];
    if (ext !== undefined) name = `${name}.${ext}`;
  }
  if (utf8Length(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = hasExtension(name) ? name.slice(dot) : '';
    const stem = ext === '' ? name : name.slice(0, dot);
    name = `${cutToBytes(stem, MAX_NAME_BYTES - utf8Length(ext)).replace(/[. ]+$/, '')}${ext}`;
  }
  return notADevice(name);
}

/**
 * Le nom tel que le modèle le lira : chaque adresse de conversation connue
 * qu'il contient remplacée par son handle, par la frontière elle-même
 * (`conversationIdsAsHandles`, celle de `addressedByHandle`). Le fichier est
 * écrit sous CE nom, et le chemin que lit le modèle est celui du disque. Une
 * personne qui l'ouvre depuis un écran lit le nom d'origine
 * (`showConversationsTo`). Un nom sans adresse est rendu tel quel.
 */
async function asTheModelReadsIt(
  db: RunnerDeps['db'],
  entityId: string,
  name: string,
): Promise<string> {
  return conversationIdsAsHandles(db, { entityId, subject: 'a received file name' }, name);
}

/**
 * Écrit `bytes` sous `name` dans `dir` sans jamais écraser : `wx` refuse un nom
 * déjà pris (y compris à la casse près, sur un système qui l'ignore), et le nom
 * suivant est essayé — `nom (2).ext`, `nom (3).ext`…
 */
async function writeUnique(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; name: string }> {
  const dot = hasExtension(name) ? name.lastIndexOf('.') : name.length;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const path = join(dir, candidate);
    try {
      await writeFile(path, bytes, { flag: 'wx' });
      return { path, name: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
}

// ─── Le ménage d'un dossier d'arrivée ─────────────────────────────────────────

/**
 * Le délai que la note d'un fichier reçu promet au modèle : avant lui, le
 * fichier n'est jamais supprimé — ni par ce ménage, ni par la purge des jobs
 * (`pruneJobMediaFiles`, cron).
 */
export const INBOUND_FILES_KEPT_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const KEPT_DAYS = Math.round(INBOUND_FILES_KEPT_MS / (24 * 60 * 60 * 1000));
/**
 * Au plus ce nombre d'entrées (un job chacune) par CONVERSATION dans le délai :
 * au-delà, un nouveau fichier de cette conversation est refusé, et c'est dit.
 * Une conversation n'en prive jamais une autre.
 */
const INBOUND_FOLDER_MAX_ENTRIES = 200;

interface PrunableEntry {
  path: string;
  /** Le job de l'entrée : le nom d'un dossier de job, ou d'un fichier `<jobId>.<ext>`. */
  jobId: string;
  mtimeMs: number;
}

/**
 * Ménage du dossier d'arrivée d'un canal, <shared>/<canal>/ (F-13) : supprime
 * ce qui a plus de 30 jours, et rien d'autre. Une entrée est le dossier d'un
 * job (`<jobId>/`, les fichiers reçus depuis #899) ou un fichier
 * `<jobId>.<ext>` (les images de Discord). Rend les jobs des entrées qui
 * restent.
 *
 * Il n'y a PAS de borne au nombre qui supprimerait les plus anciennes (revue
 * de #911) : depuis #910 le dossier tient toutes les conversations, et une
 * conversation chargée effaçait le fichier non déplacé d'une autre avant les
 * 30 jours promis. Le nombre est borné à l'ENTRÉE, par conversation
 * (`inboundRoom`).
 *
 * Chaque sous-dossier qui n'est pas celui d'un job reçoit le même ménage, et
 * rien plus bas : ce sont les fils <canal>/<conversation>/ des réceptions
 * d'avant #910 que `moveLegacyInboundFolders` n'a pas pu vider.
 *
 * Ne supprime JAMAIS l'entrée d'un job qui n'est pas encore terminé : un job
 * peut attendre une approbation, une délégation, ou son tour, avant que son
 * agent lise le fichier. L'âge seul la supprimerait sous ses pieds — une perte
 * silencieuse. L'entrée d'un job qui n'existe plus en base (purgé) n'a pas ce
 * risque.
 */
export async function pruneInboundFolder(dir: string, db: RunnerDeps['db']): Promise<string[]> {
  const top = await pruneJobEntries(dir, db);
  const kept = [...top.kept];
  for (const below of top.otherFolders) kept.push(...(await pruneJobEntries(below, db)).kept);
  return kept;
}

/**
 * La place qu'a encore la conversation du job `jobId` dans le dossier
 * d'arrivée `dir` (créé s'il n'existe pas), après son ménage : le nombre
 * d'entrées qu'elle peut y ajouter. La conversation d'une entrée est celle de
 * son job (`agent_jobs.chat_id`) ; l'entrée d'un job purgé n'est à personne.
 */
export async function inboundRoom(
  dir: string,
  db: RunnerDeps['db'],
  jobId: string,
): Promise<number> {
  await mkdir(dir, { recursive: true });
  const kept = (await pruneInboundFolder(dir, db)).filter((id) => id !== jobId);
  if (kept.length === 0) return INBOUND_FOLDER_MAX_ENTRIES;
  const rows = await db
    .select({ id: agentJobs.id, chatId: agentJobs.chatId })
    .from(agentJobs)
    .where(inArray(agentJobs.id, [...new Set([...kept, jobId])]));
  const chatOf = new Map(rows.map((r) => [r.id, r.chatId]));
  if (!chatOf.has(jobId)) {
    throw new Error(`inbound_job_unknown: job ${jobId} is not in the database`);
  }
  const conversation = chatOf.get(jobId);
  const used = kept.filter((id) => chatOf.has(id) && chatOf.get(id) === conversation).length;
  return INBOUND_FOLDER_MAX_ENTRIES - used;
}

/** Le ménage des entrées de job d'UN dossier : celles qui restent, et ses sous-dossiers qui n'en sont pas. */
async function pruneJobEntries(
  dir: string,
  db: RunnerDeps['db'],
): Promise<{ kept: string[]; otherFolders: string[] }> {
  const entries = await readdirOrNone(dir);
  const otherFolders = entries
    .filter((e) => e.isDirectory() && !isUuid(e.name))
    .map((e) => join(dir, e.name));
  const stats = await Promise.all(
    entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map(async (e) => {
        const path = join(dir, e.name);
        try {
          const st = await stat(path);
          return { path, jobId: jobOfEntry(e.name, e.isFile()), mtimeMs: st.mtimeMs };
        } catch {
          // Supprimée entre readdir et stat : rien à faire.
          return null;
        }
      }),
  );
  // Seules les entrées nommées d'après un job sont à nous : un fichier ou un
  // dossier qu'un agent a posé là sous un autre nom n'est jamais supprimé (et
  // un nom qui n'est pas un uuid ferait échouer la requête ci-dessous).
  const ours = stats.filter((s): s is PrunableEntry => s !== null && isUuid(s.jobId));

  let activeJobIds = new Set<string>();
  const jobIds = [...new Set(ours.map((c) => c.jobId))];
  if (jobIds.length > 0) {
    const rows = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(inArray(agentJobs.id, jobIds));
    activeJobIds = new Set(
      rows
        .filter((r) => r.status === null || !(TERMINAL_STATUSES as string[]).includes(r.status))
        .map((r) => r.id),
    );
  }

  const now = Date.now();
  const kept: string[] = [];
  for (const f of ours) {
    if (!activeJobIds.has(f.jobId) && now - f.mtimeMs > INBOUND_FILES_KEPT_MS) {
      await rm(f.path, { recursive: true, force: true }).catch(() => {});
    } else {
      kept.push(f.jobId);
    }
  }
  return { kept, otherFolders };
}

/** Le job d'une entrée : le nom d'un dossier, ou celui d'un fichier sans son extension. */
function jobOfEntry(name: string, isFile: boolean): string {
  if (!isFile) return name;
  const lastDot = name.lastIndexOf('.');
  return lastDot > 0 ? name.slice(0, lastDot) : '';
}

// ─── Les fils d'avant #910 ────────────────────────────────────────────────────

/** Les canaux qui ont écrit des fils <canal>/<conversation>/ avant #910. */
const LEGACY_INBOUND_CHANNELS = ['telegram', 'discord'] as const;

/**
 * Remonte dans le dossier de leur canal les entrées de job des fils
 * <shared>/<canal>/<conversation>/ que les réceptions d'avant #910 ont écrits,
 * et supprime chaque fil vidé (revue de #911). Sans cela, `file_list` et
 * `file_search` montraient au modèle `…/telegram/conv_<handle>/…` : le nom du
 * fil est l'adresse de la conversation, la frontière la remplace, et le modèle
 * ne pouvait pas ouvrir ce qu'il listait.
 *
 * Un fil est un sous-dossier du canal dont le nom EST une adresse de
 * conversation que l'espace connaît — la lecture de la frontière elle-même
 * (`conversationIdsAsHandles` en fait un handle), jamais une forme devinée : un
 * dossier qu'un agent a créé là (`Archives`) n'est pas touché. Seules les
 * entrées de job (`<jobId>/`, `<jobId>.<ext>`) remontent, leur date gardée
 * (le délai de 30 jours court toujours) ; ce qui ne peut pas remonter (un nom
 * déjà pris, un fichier tenu) reste, et c'est dit.
 *
 * Joué à chaque démarrage du runner : idempotent, un fil déjà vidé n'existe
 * plus.
 */
export async function moveLegacyInboundFolders(
  db: RunnerDeps['db'],
  root: string = workspacesRoot(),
): Promise<{ moved: number; left: string[] }> {
  let moved = 0;
  const left: string[] = [];
  const entities = await readdirOrNone(root);
  for (const entity of entities) {
    // Un espace est un uuid ; un autre dossier n'en est pas un, et la base le refuserait.
    if (!entity.isDirectory() || !isUuid(entity.name)) continue;
    for (const channel of LEGACY_INBOUND_CHANNELS) {
      const channelDir = join(root, entity.name, 'shared', channel);
      for (const sub of await readdirOrNone(channelDir)) {
        if (!sub.isDirectory() || isUuid(sub.name)) continue;
        const asRead = await conversationIdsAsHandles(
          db,
          { entityId: entity.name, subject: 'an inbound folder name' },
          sub.name,
        );
        if (!isConversationHandle(asRead)) continue;
        const conversationDir = join(channelDir, sub.name);
        for (const e of await readdirOrNone(conversationDir)) {
          if (!isUuid(jobOfEntry(e.name, e.isFile()))) continue;
          const from = join(conversationDir, e.name);
          const to = join(channelDir, e.name);
          if ((await stat(to).catch(() => null)) !== null) {
            left.push(from);
            continue;
          }
          try {
            await rename(from, to);
            moved += 1;
          } catch (err) {
            console.warn(`[inbound] could not move ${from} to ${to}: ${errorText(err)}`);
            left.push(from);
          }
        }
        await rmdir(conversationDir).catch(() => {
          left.push(conversationDir);
        });
      }
    }
  }
  if (moved > 0) {
    console.warn(`[inbound] moved ${moved} received file entr(ies) out of pre-#910 folders`);
  }
  for (const path of left) {
    console.warn(
      `[inbound] left in place (its folder name is a conversation address, which the model ` +
        `reads as a handle): ${path}`,
    );
  }
  return { moved, left };
}

async function readdirOrNone(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** La colonne `agent_jobs.id` est un uuid : un autre nom ne peut pas en être un, et Postgres refuserait la requête. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
