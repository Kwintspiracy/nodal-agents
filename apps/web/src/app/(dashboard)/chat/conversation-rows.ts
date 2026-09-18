// conversation-rows.ts — les LIGNES d'un dossier de chat (#135).
//
// La maquette (planche « Telegram folder ») ne dessine plus un tableau à six
// colonnes mais une boîte de réception : une ligne par conversation, l'agent à
// gauche, le dernier mot en dessous, l'heure à droite, et UN signe de ce qui s'y
// passe. Ce module fait tout le travail de décision ; l'écran ne fait que le
// dessiner.
//
// Pourquoi ici, et pur : trois faits arrivent de trois lectures différentes —
// les conversations, ce qui ATTEND la personne (les approbations), ce qui
// TOURNE (les runs) — et les recoller est exactement le genre de règle qui se
// trompe en silence dans un composant. Ici, elle se teste sans navigateur.
//
// ⚠️ LES SECRETS SONT MASQUÉS EN AMONT. Le titre d'un fil que personne n'a
// nommé EST la première demande de la personne, et l'aperçu la dernière réponse
// de l'agent : une clé collée dans l'un ou l'autre s'affichait ici en clair
// (SECRET-001, Reviewer C sur #179). Le masquage vit dans `firstLine`
// (lib/conversation-actions.ts) et PAS ici, parce que cette lecture-là coupe
// les deux textes — 60 et 120 signes — avant que ce module ne les voie :
// masquer après la coupe laisserait passer le début d'une clé, qui en est
// l'essentiel. Les lignes de RUN, elles, reçoivent la tâche entière et masquent
// chez elles (`runTitle`, run-rows.ts).
//
// ⚠️ CE QUI N'EST PAS DESSINÉ. La maquette montre aussi une pastille « Unread ».
// La base ne porte AUCUN état de lecture — pas de `last_read_at`, nulle part —
// donc aucune ligne ne peut dire qu'elle n'est pas lue. Elle n'est pas
// dessinée : l'inventer ferait dire à l'écran un fait que rien ne vérifie
// (invariant #4). Le jour où la colonne existe, elle s'ajoute ici.

import { chatLabel, type ChannelChatRow } from '@/lib/chat-list.ts';
import type { ConversationListRow } from '@/lib/conversation-actions.ts';
import { formatClock, truncate } from '@/lib/format-time';

/**
 * Une borne au titre d'une conversation du dashboard, et rien de plus.
 *
 * Il tenait dans une étiquette mono coupée à 40 signes, parce qu'une étiquette
 * ne s'étire pas. Depuis le 18/09 le titre EST la ligne principale et le CSS le
 * coupe à la largeur réelle de l'écran, qui est la seule bonne mesure : couper
 * plus tôt en JavaScript perdrait des mots qu'un écran large affiche très bien.
 * Ce plafond ne borne donc plus que ce qu'on envoie au navigateur.
 */
const TITLE_MAX = 120;

/** Ce qu'une ligne attend de la personne. `null` = rien. */
export type RowWaiting = 'question' | 'approval' | null;

/** Une demande en attente, telle que `listApprovalsAction` la rend. */
export type WaitingRequest = {
  /** La conversation d'où elle vient. `null` → elle ne se pose sur aucune ligne. */
  conversationId: string | null;
  /** `approval` ou `question` — lu sur la colonne, jamais déduit de l'outil. */
  kind: string;
};

/** Une ligne de la liste, prête à dessiner. Rien à recalculer à l'écran. */
export type ConversationRowModel = {
  /**
   * La conversation que la ligne ouvre. `null` pour un chat dont la base n'a
   * désigné AUCUN fil courant : la ligne existe, mais elle n'ouvre rien.
   */
  id: string | null;
  /** Stable et sans collision — la clé du chat, ou l'identifiant du fil. */
  key: string;
  /** Où mène la ligne. `null` = pas de lien, et la ligne le DIT (« unavailable »). */
  href: string | null;
  /**
   * L'agent de la ligne. `null` quand la ligne n'en montre AUCUN — le dossier
   * « Nodal chats », où toutes les conversations sont celles du même agent :
   * son nom répété n'apprend rien, et c'est le titre qui distingue les fils.
   */
  agent: { name: string | null; avatarUrl: string | null } | null;
  /**
   * Le nom du CHAT : la personne ou le salon à l'autre bout pour un canal, le
   * titre du fil pour une conversation de Nodal. Jamais vide.
   */
  chatName: string;
  /** Le dernier mot, sur une ligne. `null` → rien n'est dessiné. */
  preview: string | null;
  /** L'heure, le jour, ou la date — voir `conversationTimeLabel`. */
  time: string | null;
  waiting: RowWaiting;
  running: boolean;
};

export type ConversationRowsInput = {
  /** Les chats d'un dossier de canal. */
  chats?: readonly ChannelChatRow[];
  /** Les conversations du dossier « Nodal chats ». */
  conversations?: readonly ConversationListRow[];
  /** Les demandes EN ATTENTE, toutes provenances confondues. */
  waiting?: readonly WaitingRequest[];
  /** Les conversations sur lesquelles un run tourne. */
  runningConversationIds?: readonly string[];
  /** L'instant de référence. Paramétrable pour que le test ne dépende pas de l'heure. */
  now?: Date;
};

/**
 * L'heure d'une ligne, dans la langue courte des boîtes de réception : `14:02`
 * aujourd'hui, `Mon` dans la semaine écoulée, sinon une date brève (`Sep 12`,
 * et `Sep 12, 2025` si ce n'est pas l'année courante).
 *
 * Le jour se compare sur le CALENDRIER local, pas sur un écart d'heures : un
 * message de 23 h 50 n'affiche pas encore son heure à 00 h 10 le lendemain,
 * il affiche le jour. Même règle que `startedLabel` (spaces/format.ts), pour
 * qu'un fil ne se date pas de deux façons selon l'écran qui le montre.
 *
 * `null` quand la date manque : la colonne reste VIDE plutôt que de porter un
 * tiret qu'on lirait comme une valeur (invariant #4).
 */
export function conversationTimeLabel(at: Date | null, now: Date = new Date()): string | null {
  if (at === null) return null;
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const elapsed = Math.round((day(now) - day(at)) / 86_400_000);
  if (elapsed === 0) return formatClock(at);
  // La semaine écoulée s'écrit par son JOUR. Au-delà de six jours, le nom du
  // jour redeviendrait ambigu — « Mon » pourrait être celui d'il y a deux
  // semaines — et c'est la date qui s'écrit.
  if (elapsed >= 1 && elapsed <= 6) {
    return at.toLocaleDateString(undefined, { weekday: 'short' });
  }
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Ce qu'une conversation attend de la personne, quand plusieurs demandes s'y
 * empilent.
 *
 * Une QUESTION passe avant une APPROBATION : elle est adressée à la personne
 * — l'agent lui demande de choisir — alors qu'une approbation est une porte
 * qu'elle peut laisser fermée. Montrer l'une des deux, c'est montrer celle qui
 * la fait revenir.
 */
function strongestWaiting(kinds: readonly string[]): RowWaiting {
  if (kinds.includes('question')) return 'question';
  if (kinds.includes('approval')) return 'approval';
  // Un `kind` que le produit ne connaît pas ne devient PAS une pastille au
  // hasard : la ligne se tait, et la demande reste entière sur /approvals.
  return null;
}

/** Ce qui attend la personne, rangé PAR CONVERSATION. */
function waitingByConversation(waiting: readonly WaitingRequest[]): Map<string, string[]> {
  const byConv = new Map<string, string[]>();
  for (const w of waiting) {
    // Une demande sans conversation ne se pose sur AUCUNE ligne. Elle vient
    // d'une tâche de l'API ou d'une automation : lui choisir une ligne serait
    // inventer sa provenance.
    if (w.conversationId === null || w.conversationId === '') continue;
    const seen = byConv.get(w.conversationId);
    if (seen) seen.push(w.kind);
    else byConv.set(w.conversationId, [w.kind]);
  }
  return byConv;
}

/**
 * Les lignes d'un dossier, dans l'ordre reçu — celui des lectures, qui trient
 * déjà par activité décroissante.
 *
 * Un dossier est d'UNE sorte : les chats d'un canal, ou les conversations
 * ouvertes dans Nodal. Les deux entrées existent pour que l'appelant n'ait pas
 * à choisir un type de ligne selon la vue ; passer les deux les concatène,
 * les canaux d'abord, comme la page entière les empile.
 */
export function conversationRows(input: ConversationRowsInput): ConversationRowModel[] {
  const byConv = waitingByConversation(input.waiting ?? []);
  const running = new Set(input.runningConversationIds ?? []);
  const now = input.now ?? new Date();

  /** Ce qui se passe sur une conversation. Sans conversation, rien ne se passe. */
  const etat = (id: string | null): Pick<ConversationRowModel, 'waiting' | 'running'> => {
    if (id === null) return { waiting: null, running: false };
    return { waiting: strongestWaiting(byConv.get(id) ?? []), running: running.has(id) };
  };

  const rows: ConversationRowModel[] = [];

  for (const c of input.chats ?? []) {
    // Le fil COURANT du chat, désigné par la base. `null` quand elle n'en
    // désigne aucun : la ligne s'affiche sans lien, comme le tableau le fait
    // depuis la PR #48, et le bandeau au-dessus dit pourquoi.
    const id = c.currentConversationId;
    rows.push({
      id,
      key: c.key,
      href: id === null ? null : `/chat/${id}`,
      // Un dossier de canal montre l'agent : il CHANGE d'une ligne à l'autre,
      // et c'est lui qui répond à l'autre bout.
      agent: { name: c.agentName, avatarUrl: c.agentAvatarUrl },
      chatName: chatLabel(c),
      preview: c.lastPreview,
      time: conversationTimeLabel(c.updatedAt, now),
      ...etat(id),
    });
  }

  for (const c of input.conversations ?? []) {
    rows.push({
      id: c.id,
      key: c.id,
      href: `/chat/${c.id}`,
      // AUCUN agent sur ces lignes (Quentin, 18/09 : « pas besoin de répéter
      // l'agent partout avec son avatar »). Ce sont toutes les conversations
      // ouvertes ici, avec le même agent : le répéter coûtait la moitié de la
      // ligne sans distinguer un fil d'un autre.
      agent: null,
      // Un fil que personne n'a nommé et que l'IA n'a pas encore renommé n'a
      // pas de titre. « Untitled » dit ce que c'est ; un titre vide se lirait
      // comme un défaut d'affichage.
      chatName: c.title === '' ? 'Untitled' : truncate(c.title, TITLE_MAX),
      // PAS de dernier message (Quentin, 18/09). Le titre dit de quoi parle le
      // fil ; le dernier mot posté, lui, est souvent une phrase de politesse ou
      // la moitié d'un compte rendu, et il poussait le titre en haut d'une
      // ligne à deux étages pour ne rien apprendre.
      preview: null,
      time: conversationTimeLabel(c.updatedAt, now),
      ...etat(c.id),
    });
  }

  return rows;
}
