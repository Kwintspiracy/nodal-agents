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

// ─── Les identifiants DÉJÀ écrits, à la frontière du modèle (#824, passe 1) ──
//
// Les écrivains écrivent désormais des handles, mais le texte déjà stocké — le
// résultat d'un job rejoué en historique, les messages d'un job repris, une
// mémoire — porte encore l'identifiant du canal. Ce qui part chez le
// fournisseur passe donc par `replaceConversationIds` : chaque identifiant de
// conversation CONNU de l'entité (une liste exacte, jamais une forme devinée)
// devient son handle. Un identifiant ne compte que s'il est entier : ni
// précédé ni suivi d'un caractère qui le prolongerait (`5551` ne contient pas
// le chat `555`, `-100123` n'est pas le chat `100123`, `555@s.whatsapp.net`
// n'est pas le chat `555`).

/** Les champs d'une requête qui ne sont pas du texte lu par le modèle : signatures du fournisseur. */
const NOT_MODEL_TEXT = new Set(['providerOptions', 'providerMetadata']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Le motif qui trouve ces identifiants EXACTS dans un texte, le plus long
 * d'abord ; `null` quand il n'y en a aucun.
 */
export function conversationIdsPattern(ids: Iterable<string>): RegExp | null {
  const list = [...new Set(ids)].filter((id) => id.length > 0);
  if (list.length === 0) return null;
  list.sort((a, b) => b.length - a.length);
  return new RegExp(
    `(?<![A-Za-z0-9_@.+\\-])(?:${list.map(escapeRegExp).join('|')})(?![A-Za-z0-9_@])`,
    'g',
  );
}

function walkModelText(value: unknown, onString: (s: string) => string): unknown {
  if (typeof value === 'string') return onString(value);
  if (Array.isArray(value)) return value.map((v) => walkModelText(v, onString));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(value)) {
      out[k] = NOT_MODEL_TEXT.has(k) ? inner : walkModelText(inner, onString);
    }
    return out;
  }
  return value;
}

/** Les identifiants du motif présents dans une valeur destinée à un modèle. */
export function conversationIdsIn(value: unknown, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  walkModelText(value, (s) => {
    for (const m of s.matchAll(pattern)) found.add(m[0]);
    return s;
  });
  return found;
}

/**
 * La même valeur, chaque identifiant trouvé remplacé par son handle. Un
 * identifiant sans handle dans la table reste tel quel (l'appelant n'en donne
 * pas : il mint d'abord ceux qu'il a trouvés).
 */
export function replaceConversationIds<T>(
  value: T,
  pattern: RegExp,
  handles: ReadonlyMap<string, string>,
): T {
  if (handles.size === 0) return value;
  return walkModelText(value, (s) => s.replace(pattern, (id) => handles.get(id) ?? id)) as T;
}
