// conversation-handle.ts — la FORME d'une adresse de conversation telle qu'un
// modèle la lit (#824), et sa lecture par une personne.
//
// Un texte qui part chez un fournisseur de modèle nomme une conversation de
// canal par un HANDLE, jamais par l'identifiant que le canal lui donne (un DM
// WhatsApp s'appelle par un numéro de téléphone). Les handles sont créés et
// relus en base (`conversationHandlesFor`, `conversationsOfHandles` dans
// @nodal-agents/db) ; ce module ne porte que ce qui ne demande aucune base : la
// forme, que les outils d'envoi acceptent en entrée, et le remplacement des
// handles par leurs conversations dans ce qu'un écran montre.
//
// La forme (`conv_` puis 10 caractères base32 minuscules) ne ressemble à
// l'identifiant d'aucun canal — ni un nombre (Telegram, Discord), ni des
// majuscules (Slack), ni un `@` (WhatsApp) — et la base la garde
// (`conversation_handles_id_check`, migration 0152).

/** Un handle de conversation : seule forme sous laquelle un modèle lit une adresse de canal. */
export type ConversationHandle = string & { readonly __conversationHandle: true };

/** La conversation qu'un handle nomme. */
export interface HandledConversation {
  channel: string;
  conversationId: string;
}

/** Un handle, et rien d'autre (la forme que garde `conversation_handles_id_check`). */
export const CONVERSATION_HANDLE_RE = /^conv_[a-z2-7]{10}$/;

/** Un handle dans un texte : ni précédé ni suivi d'un caractère qui le prolongerait. */
const HANDLE_IN_TEXT_RE = /(?<![A-Za-z0-9_])conv_[a-z2-7]{10}(?![A-Za-z0-9_])/g;

/** Cette chaîne est-elle un handle (et non l'identifiant d'un canal) ? */
export function isConversationHandle(value: string): value is ConversationHandle {
  return CONVERSATION_HANDLE_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Tous les handles écrits dans une valeur (chaînes à toute profondeur, clés exclues). */
export function conversationHandlesIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(HANDLE_IN_TEXT_RE)) out.add(m[0]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isPlainObject(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/**
 * La même valeur, chaque handle connu remplacé par l'identifiant de la
 * conversation qu'il nomme — ce qu'une PERSONNE lit là où un modèle a lu le
 * handle. Un handle inconnu reste tel quel : rien n'est deviné. Les objets qui
 * ne sont pas de simples enregistrements (une date) sont rendus tels quels.
 */
export function showConversationHandles<T>(
  value: T,
  conversations: ReadonlyMap<string, HandledConversation>,
): T {
  if (conversations.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(HANDLE_IN_TEXT_RE, (h) => conversations.get(h)?.conversationId ?? h);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
