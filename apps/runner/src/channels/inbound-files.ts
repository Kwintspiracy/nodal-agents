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
//   - est rangé dans le dossier partagé de l'espace, un dossier par job sous le
//     fil : <shared>/<canal>/<conversation>/<jobId>/<nom d'origine>. Le nom
//     d'origine est gardé (nettoyé pour Windows, macOS et Linux), jamais écrasé
//     (suffixe « (2) » si le nom existe déjà). Le dossier du job porte la clé
//     que lisent les deux ménages (`pruneInboundFolder` ici, `pruneJobMediaFiles`
//     du cron) : sans lui, un nom d'origine ne dirait plus à quel job il est ;
//   - devient UNE partie texte du premier message du job, pour l'agent : son
//     chemin pour les outils fichiers (`shared/…`) et son chemin absolu (un
//     runtime CLI n'a que lui), son nom, son type, sa taille ;
//   - garde en plus sa partie image quand ses octets sont une image qu'un modèle
//     prend — la forme des photos d'avant (`{ type: 'image', image: <absolu> }`),
//     que `hydrateForLlm` change en octets au moment de l'appel ;
//   - ou, quand il n'a pas pu être obtenu ou écrit (trop gros pour le canal,
//     réseau, délai), devient une partie texte qui dit lequel et pourquoi :
//     l'agent le dit dans sa réponse. Jamais abandonné.
//
// Le texte de ces parties s'adresse au MODÈLE, comme les notes d'image de
// job/model-images.ts : il n'est pas montré à la personne par le runner.

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import {
  MODEL_IMAGE_MEDIA_TYPES,
  SHARED_WORKSPACE_LABEL,
  formatBytes,
  sniffImageMediaType,
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

/** Le fil d'un canal sous le dossier partagé : <shared>/<canal>/<conversation>. */
export function inboundFolder(entityId: string, channel: string, conversationId: string): string {
  return join(
    workspacesRoot(),
    entityId,
    'shared',
    safePathSegment(channel),
    safePathSegment(conversationId),
  );
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
 * autres : il devient sa phrase. Seule l'écriture en base peut lever.
 */
export async function receiveInboundFiles(args: {
  db: RunnerDeps['db'];
  jobId: string;
  entityId: string;
  channel: string;
  conversationId: string;
  /** Le texte du message de la personne, tel que le job le porte déjà. */
  text: string;
  files: readonly InboundFile[];
}): Promise<{ attached: boolean; outcomes: InboundFileOutcome[] }> {
  const { db, jobId, entityId, channel, conversationId, text, files } = args;
  const folder = inboundFolder(entityId, channel, conversationId);
  const jobFolder = join(folder, jobId);
  const workspaceFolder = [
    SHARED_WORKSPACE_LABEL,
    safePathSegment(channel),
    safePathSegment(conversationId),
    jobId,
  ].join('/');

  const outcomes: InboundFileOutcome[] = [];
  const parts: unknown[] = [{ type: 'text', text }];
  for (const file of files) {
    const shownName = displayName(file);
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
      saved = await writeUnique(jobFolder, safeFileName(file.name, mediaType), bytes);
    } catch (err) {
      const outcome = failed(file, shownName, `it could not be saved: ${errorText(err)}`);
      outcomes.push(outcome);
      parts.push({ type: 'text', text: notReceivedNote(outcome) });
      continue;
    }
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
      parts.push({ type: 'image', image: saved.path });
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

  // Ménage borné du fil (F-13), au mieux : il ne fait jamais échouer une
  // réception déjà faite.
  await pruneInboundFolder(folder, db).catch((err) => {
    console.warn(
      `[${channel}] inbound folder prune failed for ${folder}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

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
  const days = Math.round(INBOUND_FOLDER_MAX_AGE_MS / (24 * 60 * 60 * 1000));
  const inbox = workspaceFolder.slice(0, workspaceFolder.lastIndexOf('/') + 1);
  return (
    `[File sent with this message: ${describe(o.name, o.mediaType, o.size)}. ` +
    `Saved at ${o.workspacePath} for the file tools (absolute path: ${o.path}). ` +
    `Files left under ${inbox} are deleted after ${days} days: move it to keep it.]`
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

/** Les noms que Windows réserve, avec ou sans extension (`CON`, `nul.txt`, `COM1.pdf`…). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/** L'extension d'un type, pour un nom qui n'en a pas (une image doit en avoir une pour être relue). */
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

/** Un segment de chemin sûr (un nom de canal, un identifiant de conversation). */
function safePathSegment(raw: string): string {
  const cleaned = cutToBytes(cleanSegment(raw), MAX_NAME_BYTES);
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '_';
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
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
  return WINDOWS_RESERVED.test(name) ? `_${name}` : name;
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

// ─── Le ménage d'un fil ───────────────────────────────────────────────────────

/** Au plus ce nombre d'entrées (un job chacune) par fil. */
const INBOUND_FOLDER_MAX_ENTRIES = 200;
/** Une entrée plus vieille que ça est supprimée, quel que soit leur nombre. */
const INBOUND_FOLDER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

interface PrunableEntry {
  path: string;
  /** Le job de l'entrée : le nom d'un dossier de job, ou d'un fichier `<jobId>.<ext>`. */
  jobId: string;
  mtimeMs: number;
}

/**
 * Ménage borné d'un fil <shared>/<canal>/<conversation>/ (F-13) : supprime ce
 * qui a plus de 30 jours, puis, s'il reste plus de 200 entrées, les plus
 * anciennes. Une entrée est le dossier d'un job (`<jobId>/`, les fichiers reçus
 * depuis #899) ou un fichier `<jobId>.<ext>` (les images d'avant, et celles de
 * Discord).
 *
 * Ne supprime JAMAIS l'entrée d'un job qui n'est pas encore terminé : un job
 * peut attendre une approbation, une délégation, ou son tour, avant que son
 * agent lise le fichier. L'âge ou le nombre seuls le supprimeraient sous ses
 * pieds — une perte silencieuse. L'entrée d'un job qui n'existe plus en base
 * (purgé) n'a pas ce risque.
 */
export async function pruneInboundFolder(dir: string, db: RunnerDeps['db']): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const stats = await Promise.all(
    entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map(async (e) => {
        const path = join(dir, e.name);
        try {
          const st = await stat(path);
          let jobId = e.name;
          if (e.isFile()) {
            const lastDot = e.name.lastIndexOf('.');
            jobId = lastDot > 0 ? e.name.slice(0, lastDot) : '';
          }
          return { path, jobId, mtimeMs: st.mtimeMs };
        } catch {
          // Supprimée entre readdir et stat : rien à faire.
          return null;
        }
      }),
  );
  // Seules les entrées nommées d'après un job sont à nous : un fichier ou un
  // dossier qu'un agent a posé là sous un autre nom n'est jamais supprimé (et
  // un nom qui n'est pas un uuid ferait échouer la requête ci-dessous).
  let candidates = stats.filter((s): s is PrunableEntry => s !== null && isUuid(s.jobId));

  const jobIds = [...new Set(candidates.map((c) => c.jobId))];
  if (jobIds.length > 0) {
    const rows = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(inArray(agentJobs.id, jobIds));
    const activeJobIds = new Set(
      rows
        .filter((r) => r.status === null || !(TERMINAL_STATUSES as string[]).includes(r.status))
        .map((r) => r.id),
    );
    candidates = candidates.filter((c) => !activeJobIds.has(c.jobId));
  }

  const remove = (path: string) => rm(path, { recursive: true, force: true }).catch(() => {});
  const now = Date.now();
  const stillFresh: typeof candidates = [];
  for (const f of candidates) {
    if (now - f.mtimeMs > INBOUND_FOLDER_MAX_AGE_MS) await remove(f.path);
    else stillFresh.push(f);
  }
  candidates = stillFresh;

  if (candidates.length > INBOUND_FOLDER_MAX_ENTRIES) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = candidates.length - INBOUND_FOLDER_MAX_ENTRIES;
    for (const f of candidates.slice(0, excess)) await remove(f.path);
  }
}

/** La colonne `agent_jobs.id` est un uuid : un autre nom ne peut pas en être un, et Postgres refuserait la requête. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
