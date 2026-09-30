// conversation-inbox.ts — un message arrivé pendant que le travail de sa
// conversation tourne (#531).
//
// Tant qu'un job de TÊTE d'une conversation n'est pas terminal, un nouveau
// message de cette conversation ne démarre pas un second job : il entre dans la
// file (`agent_jobs.inbox`) de la tête, et la boucle la vide en haut de chaque
// tour. Le modèle lit donc la précision (« et mets-le dans le dossier partagé »)
// dans le travail qui la concerne, au lieu d'un second job qui refait tout.
//
// Un message vidé entre dans la transcription comme un message de la personne,
// avec une marque STRUCTURELLE : `providerOptions.nodal.inbox`. Même principe
// que le relevé du runner (runner-record.ts) : un champ que seule la
// plateforme produit, qu'aucun fournisseur ne lit, et qu'aucun texte ne peut
// imiter. Il sert à deux lectures, et à rien d'autre :
//   - la frontière du tour (`findTaskBoundary`) : un message vidé qui répète
//     mot pour mot la tâche n'en est pas le début ;
//   - l'historique rejoué (thread-history.ts) : un message vidé ne disparaît
//     jamais des tours suivants.
//
// Le TEXTE que lit le modèle est celui de la personne, tel quel : le runner
// n'y ajoute rien (invariant #2).

import { RUNNER_RECORD_NAMESPACE } from './runner-record';

/** Le contenu d'un message de la personne : du texte, ou du texte et une image (chemin). */
export type InboxContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; image: string }>;

/** Une entrée de la file d'un job de tête, telle qu'elle vit dans `agent_jobs.inbox`. */
export interface InboxEntry {
  /** Identifiant de l'entrée : un média arrivé après coup s'y rattache par lui. */
  id: string;
  /** Le texte du message : la tâche du job qu'il deviendrait s'il en démarrait un. */
  task: string;
  /** Ce que le modèle lira. */
  content: InboxContent;
  /** ISO 8601, posé par la plateforme à la réception. */
  receivedAt: string;
}

/** Le message qu'une entrée vidée devient dans la transcription. */
export interface InboxMessage {
  role: 'user';
  content: InboxContent;
  providerOptions: { nodal: { inbox: { id: string; receivedAt: string } } };
}

export function inboxMessage(entry: InboxEntry): InboxMessage {
  return {
    role: 'user',
    content: entry.content,
    providerOptions: {
      [RUNNER_RECORD_NAMESPACE]: { inbox: { id: entry.id, receivedAt: entry.receivedAt } },
    },
  };
}

/** Ce message est-il un message de la personne remis à un travail en cours ? */
export function isInboxMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { role?: unknown; providerOptions?: unknown };
  if (m.role !== 'user') return false;
  const ns = (m.providerOptions as Record<string, unknown> | undefined)?.[RUNNER_RECORD_NAMESPACE];
  const inbox = (ns as { inbox?: unknown } | undefined)?.inbox;
  return typeof inbox === 'object' && inbox !== null;
}
