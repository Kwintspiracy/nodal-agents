// chat-folders.ts — le menu Chat de la barre latérale (#135).
//
// « Chat » n'est plus un lien mais un GROUPE : un dossier par endroit d'où les
// conversations arrivent — un par canal branché, et « Nodal chats » pour
// celles ouvertes ici. PAS de dossier « Routines » : une automation n'est pas
// un dialogue, personne n'y parle à un agent (Quentin, 17/09/2026). Les runs
// programmés ont leur page, Scheduled, et leurs demandes en attente restent
// sur /approvals.
//
// Chaque dossier porte DEUX signaux, et tout l'intérêt est de ne pas les
// confondre :
//
//   - la PASTILLE corail compte ce qui ATTEND LA PERSONNE. C'est un nombre
//     qu'elle peut faire tomber à zéro en répondant. Elle est cachée à zéro :
//     une pastille « 0 » demande de la lire pour apprendre qu'il n'y a rien.
//   - le POINT vert dit qu'un run TOURNE. Ce n'est pas du travail pour elle,
//     et il ne porte JAMAIS de nombre : deux chiffres côte à côte, l'un
//     d'attentes et l'autre de runs, ne se lisent plus.
//
// ⚠️ CE QUI N'EST PAS COMPTÉ, et pourquoi. La base ne porte AUCUN état de
// lecture — pas de `last_read_at`, nulle part. Une réponse d'agent non lue
// n'est donc pas comptable, et elle n'est pas comptée : inventer un état de
// lecture ici ferait dire à la pastille un chiffre que rien ne peut vérifier
// (invariant #4). Même chose pour « un livrable à vérifier » : aucune colonne
// ne dit qu'un livrable attend un œil. Le jour où l'une des deux existe, elle
// s'ajoute à `waiting` sans rien changer d'autre.

import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';
import { CHANNEL_LABELS } from './activity-runs.ts';

/** Le dossier des conversations ouvertes dans Nodal même. */
export const DASHBOARD_FOLDER = 'dashboard';

/**
 * L'ordre des dossiers de canal. Celui de la maquette — pas l'ordre
 * alphabétique, ni celui où la base rend ses lignes, qui changerait d'un
 * chargement à l'autre.
 */
const CHANNEL_ORDER: readonly string[] = ['telegram', 'slack', 'discord', 'whatsapp'];

/**
 * Les statuts qui font TOURNER un run, donc allumer le point vert.
 *
 * DÉRIVÉS de la liste du produit (`LIVE_JOB_STATUSES`) moins
 * `awaiting_approval` : un run arrêté sur une approbation n'avance pas, il
 * attend la personne — et c'est déjà ce que dit la pastille. Les afficher tous
 * les deux ferait porter à chaque dossier en attente un point qui répète la
 * pastille sans rien ajouter.
 *
 * Écrits par soustraction, jamais recopiés : un statut vivant ajouté demain
 * allume le point sans que personne n'y pense.
 */
export const RUNNING_JOB_STATUSES: readonly string[] = LIVE_JOB_STATUSES.filter(
  (s) => s !== 'awaiting_approval',
);

/**
 * Le dossier auquel appartient le travail d'un job, lu sur SON CANAL.
 *
 * `null` quand le job ne relève d'aucun dossier du menu Chat — `api` (la boîte
 * « New task », qui n'est pas une conversation), `internal`, `mcp`, `webhook`,
 * `task-board`. Ce travail-là reste entier sur `/approvals` ; il n'est
 * simplement rangé dans aucun dossier de chat, et aucun chiffre ne le compte
 * deux fois.
 */
export function folderOfJobChannel(channel: string | null): string | null {
  if (channel === null || channel === '') return null;
  // Une automation n'a pas de dossier : elle n'est pas un endroit où l'on parle.
  if (channel === 'cron') return null;
  if (channel === 'dashboard') return DASHBOARD_FOLDER;
  if (CHANNEL_ORDER.includes(channel)) return channel;
  return null;
}

/** Le nom d'un dossier. Un canal inconnu se rend TEL QUEL, comme la colonne
 *  « d'où vient la demande » le fait : un canal ajouté demain doit s'afficher,
 *  pas disparaître. */
export function folderLabel(key: string): string {
  if (key === DASHBOARD_FOLDER) return 'Nodal chats';
  return CHANNEL_LABELS[key] ?? key;
}

/** Où mène un dossier : `/chat`, filtré sur lui. */
export function folderHref(key: string): string {
  return `/chat?folder=${encodeURIComponent(key)}`;
}

export type ChatFolder = {
  /** L'identité du dossier — et la valeur de `folder=` dans l'URL. */
  key: string;
  label: string;
  href: string;
  /** Ce qui attend la personne ici. 0 = pas de pastille du tout. */
  waiting: number;
  /** Un run tourne ici. Un booléen, jamais un compte. */
  running: boolean;
  active: boolean;
};

export type ChatFoldersInput = {
  /** Les canaux qui portent au moins une conversation (lus en base). */
  channels: readonly string[];
  /** Une entrée par demande en attente, avec le canal du job qui la porte. */
  waiting: readonly { jobChannel: string | null }[];
  /** Combien de runs tournent, par dossier. Une clé absente vaut zéro. */
  running: Readonly<Record<string, number>>;
  /** Le chemin courant : un dossier n'est actif que SUR . */
  pathname: string;
  /** Le `folder=` de l'URL, pour l'état actif des dossiers de chat. */
  folderParam: string | null;
};

/**
 * Quels dossiers EXISTENT, dans l'ordre où ils s'affichent.
 *
 * Un canal sans conversation n'a pas de dossier — la maquette montre les
 * endroits où l'on parle, pas le catalogue des canaux que le produit sait
 * brancher. Mais un canal qui porte du travail EN ATTENTE ou un run qui tourne
 * a son dossier même si aucune conversation n'a été lue : sans cela, une
 * approbation aurait disparu du menu en silence, et son compte avec elle
 * (invariant #4).
 *
 * « Nodal chats » est TOUJOURS là : c'est une destination permanente du
 * produit — la page existe, vide ou non — et la faire apparaître et
 * disparaître ferait bouger le menu sous le curseur.
 */
function existingKeys(input: Pick<ChatFoldersInput, 'channels' | 'waiting' | 'running'>): string[] {
  const chan = new Set<string>();
  for (const c of input.channels) {
    const key = folderOfJobChannel(c);
    // Une conversation du dashboard ne « crée » pas le dossier Nodal chats :
    // il est de toute façon là. Les autres canaux, oui.
    if (key !== null && key !== DASHBOARD_FOLDER) chan.add(key);
  }
  for (const w of input.waiting) {
    const key = folderOfJobChannel(w.jobChannel);
    if (key !== null && key !== DASHBOARD_FOLDER) chan.add(key);
  }
  for (const [key, count] of Object.entries(input.running)) {
    if (count > 0 && key !== DASHBOARD_FOLDER) chan.add(key);
  }
  const known = CHANNEL_ORDER.filter((c) => chan.has(c));
  // Un canal que la maquette ne connaît pas se range après, par ordre
  // alphabétique — un ordre stable, plutôt que celui de la base.
  const unknown = [...chan].filter((c) => !CHANNEL_ORDER.includes(c)).sort();
  // « Nodal chats » EN TÊTE (Quentin, 18/09) : c'est le dossier où l'on parle
  // depuis le dashboard, celui qu'on ouvre le plus ; les canaux suivent, dans
  // l'ordre de la maquette, puis ceux qu'elle ne connaît pas.
  return [DASHBOARD_FOLDER, ...known, ...unknown];
}

/** Ce qui attend la personne, rangé par dossier. */
function waitingByFolder(waiting: ChatFoldersInput['waiting']): Map<string, number> {
  const byFolder = new Map<string, number>();
  for (const w of waiting) {
    const key = folderOfJobChannel(w.jobChannel);
    if (key === null) continue;
    byFolder.set(key, (byFolder.get(key) ?? 0) + 1);
  }
  return byFolder;
}

/**
 * Un dossier est ACTIF quand l'URL le désigne : le `folder=` de `/chat`. Sur
 * `/scheduled`, aucun ne l'est : Scheduled a son propre lien dans le menu.
 *
 * Un fil ouvert (`/chat/<id>`) ne rallume aucun dossier : rien dans son URL ne
 * dit d'où il vient, et deviner le rendrait faux une fois sur deux.
 */
function isFolderActive(key: string, pathname: string, folderParam: string | null): boolean {
  return pathname === '/chat' && folderParam === key;
}

/** Les lignes du groupe « Chat folders », prêtes à rendre. */
export function chatFolders(input: ChatFoldersInput): ChatFolder[] {
  const byFolder = waitingByFolder(input.waiting);
  return existingKeys(input).map((key) => ({
    key,
    label: folderLabel(key),
    href: folderHref(key),
    waiting: byFolder.get(key) ?? 0,
    running: (input.running[key] ?? 0) > 0,
    active: isFolderActive(key, input.pathname, input.folderParam),
  }));
}

/**
 * Le compte que porte le lien « Chat » lui-même : le total de ce qui attend la
 * personne dans ses dossiers de chat.
 *
 * Il se calcule sur les MÊMES dossiers que le groupe en dessous — la somme des
 * pastilles, à la lettre. Un total qui compterait une attente sans dossier
 * serait un chiffre que rien à l'écran ne justifie.
 */
export function chatWaitingTotal(
  input: Pick<ChatFoldersInput, 'channels' | 'waiting' | 'running'>,
): number {
  const byFolder = waitingByFolder(input.waiting);
  return existingKeys(input).reduce((sum, key) => sum + (byFolder.get(key) ?? 0), 0);
}
