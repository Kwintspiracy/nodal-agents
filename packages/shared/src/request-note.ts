// request-note.ts — une note du runner qui n'appartient qu'à LA demande en cours (#1088).
//
// Une note de ce genre suit le message auquel le modèle répond, et dit au
// modèle ce qui gouverne CETTE réponse. Elle n'est rangée nulle part : ni dans
// `chat_messages`, ni dans un historique rejoué plus tard. La demande suivante
// en porte une autre, pour son propre message.
//
// La provenance est STRUCTURELLE, comme celle d'un relevé (runner-record.ts) :
// `providerOptions.nodal.requestNote`, un champ que seul le runner produit et
// qu'aucun fournisseur ne lit. Le cache de prompt le lit, lui : une note qui ne
// sera jamais rejouée n'a rien à faire dans le préfixe mis en cache, et le
// point de cache glissant se pose sur le dernier message qui, lui, sera rejoué
// (`withAnthropicPromptCaching`). Sans quoi chaque tour écrirait en cache un
// préfixe que le tour suivant, privé de la note, ne retrouverait jamais.

import { RUNNER_RECORD_NAMESPACE } from './runner-record';

/** Le message d'une note de la demande en cours, tel qu'il entre dans la requête. */
export interface RequestNoteMessage {
  role: 'user';
  content: string;
  providerOptions: { nodal: { requestNote: true } };
}

export function requestNoteMessage(text: string): RequestNoteMessage {
  if (text.trim() === '') throw new Error('requestNoteMessage: a request note has no text');
  return {
    role: 'user',
    content: text,
    providerOptions: { [RUNNER_RECORD_NAMESPACE]: { requestNote: true } },
  };
}

/** Ce message est-il une note de la demande en cours (jamais rejouée) ? */
export function isRequestNote(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { role?: unknown; providerOptions?: unknown };
  if (m.role !== 'user') return false;
  const ns = (m.providerOptions as Record<string, unknown> | undefined)?.[RUNNER_RECORD_NAMESPACE];
  return (ns as { requestNote?: unknown } | undefined)?.requestNote === true;
}
