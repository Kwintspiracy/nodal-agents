// conversation-inbox.ts — la file d'un job vivant (#531).
//
// Un message qui arrive pendant que le travail d'une conversation tourne
// démarre un TOUR DE RÉPONSE : un job court du même agent, qui voit ce qui
// tourne et décide — répondre, transmettre au travail en cours, l'arrêter,
// lancer autre chose. Transmettre, c'est écrire dans la FILE du job visé
// (`agent_jobs.inbox`, outil `message_conversation_run`) ; sa boucle la vide
// en haut de chaque tour et avant de conclure.
//
// Un message vidé entre dans la transcription comme un message de rôle
// utilisateur, avec une marque STRUCTURELLE : `providerOptions.nodal.inbox`.
// Même principe que le relevé du runner (runner-record.ts) : un champ que seule
// la plateforme produit, qu'aucun fournisseur ne lit, et qu'aucun texte ne
// peut imiter. Il sert à deux lectures, et à rien d'autre :
//   - la frontière du tour (`findTaskBoundary`) : un message vidé qui répète
//     mot pour mot la tâche n'en est pas le début ;
//   - l'historique rejoué (thread-history.ts) : un message vidé ne disparaît
//     jamais des tours suivants.
//
// Le TEXTE que lit le modèle est celui qui a été transmis, tel quel : le
// runner n'y ajoute rien (invariant #2).
//
// Un tour de réponse qui transmet ne retape pas la personne (handoff.ts) : la
// plateforme met dans l'entrée les MOTS de la personne (`content`, la tâche
// du tour de réponse), et le message du modèle va à côté, comme sa note
// (`note`). Vidée, l'entrée donne deux messages : les mots, marqués comme un
// message remis, puis la note sous son cadre, marquée comme une note — que
// l'historique rejoué ne prend jamais pour une précision de la personne.

import { RUNNER_RECORD_NAMESPACE } from './runner-record';
import { handoffNote, handoffNoteMessage, type HandoffNoteMessage } from './handoff';

/** Le contenu d'un message transmis : du texte. */
export type InboxContent = string;

/** Une entrée de la file d'un job, telle qu'elle vit dans `agent_jobs.inbox`. */
export interface InboxEntry {
  /** Identifiant de l'entrée. */
  id: string;
  /** Le texte du message : la tâche de la tête qu'il deviendrait s'il en relançait une. */
  task: string;
  /** Ce que le modèle lira. */
  content: InboxContent;
  /** ISO 8601, posé par la plateforme à la remise. */
  receivedAt: string;
  /** Le job qui l'a transmis (un tour de réponse), quand il y en a un. */
  fromJobId?: string;
  /**
   * Ce que le modèle qui a transmis a écrit à côté des mots de la personne :
   * sa note (handoff.ts). Absente quand il n'a rien ajouté. Une tête relancée
   * de cette entrée la porte en `handoff_note`.
   */
  note?: string;
}

/** Le message qu'une entrée vidée devient dans la transcription. */
export interface InboxMessage {
  role: 'user';
  content: InboxContent;
  providerOptions: { nodal: { inbox: { id: string; receivedAt: string } } };
}

/** Le message remis : les mots de l'entrée, marqués. */
export function inboxMessage(entry: InboxEntry): InboxMessage {
  return {
    role: 'user',
    content: entry.content,
    providerOptions: {
      [RUNNER_RECORD_NAMESPACE]: { inbox: { id: entry.id, receivedAt: entry.receivedAt } },
    },
  };
}

/**
 * Ce qu'une entrée vidée devient dans la transcription : le message remis,
 * puis la note de qui l'a transmis, s'il en a écrit une.
 */
export function inboxMessages(entry: InboxEntry): Array<InboxMessage | HandoffNoteMessage> {
  const note = handoffNote(entry.note, entry.content);
  return note === null ? [inboxMessage(entry)] : [inboxMessage(entry), handoffNoteMessage(note)];
}

/** Ce message est-il un message transmis à un travail en cours ? */
export function isInboxMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { role?: unknown; providerOptions?: unknown };
  if (m.role !== 'user') return false;
  const ns = (m.providerOptions as Record<string, unknown> | undefined)?.[RUNNER_RECORD_NAMESPACE];
  const inbox = (ns as { inbox?: unknown } | undefined)?.inbox;
  return typeof inbox === 'object' && inbox !== null;
}

/**
 * L'heure où un message transmis est arrivé (ISO 8601, posée à la remise), ou
 * `null` si ce message n'en est pas un. L'historique rejoué la date avec (#650).
 */
export function inboxMessageReceivedAt(message: unknown): string | null {
  if (!isInboxMessage(message)) return null;
  const m = message as { providerOptions: Record<string, { inbox: { receivedAt?: unknown } }> };
  const receivedAt = m.providerOptions[RUNNER_RECORD_NAMESPACE]?.inbox.receivedAt;
  return typeof receivedAt === 'string' ? receivedAt : null;
}
