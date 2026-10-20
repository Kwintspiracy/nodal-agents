// queries/conversation-handles.ts — LA façon d'écrire une adresse de
// conversation pour un modèle, et de la relire (#824).
//
// LA RÈGLE : un texte qui part chez un fournisseur de modèle nomme une
// conversation de canal par son HANDLE, jamais par l'identifiant du canal. Le
// défaut qui l'a fait écrire : une conversation WhatsApp directe s'appelle
// `<téléphone>@s.whatsapp.net`, et le numéro partait chez le fournisseur dans
// le contexte du job, l'avis de livraison d'un délégué, `list_conversations`,
// le `by:` d'une réponse à une carte. Un canal futur dont l'identifiant est un
// e-mail ou un numéro aurait eu le même défaut.
//
// Tout écrivain d'une adresse destinée à un modèle passe par
// `conversationHandlesFor` (ou `conversationHandleFor`, la même pour une
// seule) : le runner (contexte du job, avis de livraison, réponse à une carte)
// comme les outils (`list_conversations`, les erreurs des outils d'envoi). Les
// outils qui prennent une adresse la relisent par `resolveConversationHandle`,
// DANS l'entité du job, avant leurs contrôles habituels. Un écran qui montre ce
// qu'un modèle a écrit relit les handles par `conversationsOfHandles` : une
// personne voit toujours la vraie conversation.
//
// Le handle est TIRÉ AU HASARD, jamais dérivé de l'identifiant : le hachage
// d'un numéro de téléphone se renverse par énumération. Sa forme (`conv_` puis
// 10 caractères base32 minuscules) ne ressemble à l'identifiant d'aucun canal
// — ni un nombre (Telegram, Discord), ni des majuscules (Slack), ni un `@`
// (WhatsApp) — et la base la garde (`conversation_handles_id_check`).

import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  conversationHandlesIn,
  isConversationHandle,
  showConversationHandles,
  type ConversationHandle,
  type HandledConversation,
} from '@nodal-agents/shared';
import { conversationHandles } from '../schema/conversation-handles.ts';
import type { AnyDrizzleDb } from '../client.ts';

const HANDLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const HANDLE_LENGTH = 10;

/** 10 octets aléatoires, 5 bits chacun : 256 est un multiple de 32, le tirage est uniforme. */
function newHandle(): string {
  const bytes = randomBytes(HANDLE_LENGTH);
  let body = '';
  for (const b of bytes) body += HANDLE_ALPHABET[b & 31];
  return `conv_${body}`;
}

function requireEntity(entityId: string | null | undefined): string {
  if (!entityId) {
    throw new Error(
      'conversation_handle_no_entity: a conversation address is named within an entity, ' +
        'and this caller has none.',
    );
  }
  return entityId;
}

/**
 * Le handle de chaque conversation donnée, dans cette entité et ce canal — créé
 * la première fois, relu ensuite (get-or-create).
 *
 * Sûr sous la concurrence : deux appels simultanés pour la même conversation
 * insèrent chacun `ON CONFLICT DO NOTHING`, la clé unique (entité, canal,
 * conversation) n'en garde qu'une ligne, et tous deux relisent CELLE-LÀ. Le
 * même `DO NOTHING` absorbe un tirage qui tomberait sur un handle déjà pris :
 * la conversation reste sans ligne et reçoit un nouveau tirage. Trois tirages
 * sans succès disent une panne, jamais un handle inventé (invariant #4).
 */
export async function conversationHandlesFor(
  db: AnyDrizzleDb,
  params: { entityId: string | null; channel: string; conversationIds: readonly string[] },
): Promise<Map<string, ConversationHandle>> {
  const entityId = requireEntity(params.entityId);
  const { channel } = params;
  const wanted = [...new Set(params.conversationIds)];
  const found = new Map<string, ConversationHandle>();
  if (wanted.length === 0) return found;

  for (let attempt = 0; attempt < 3; attempt++) {
    const missing = wanted.filter((id) => !found.has(id));
    await db
      .insert(conversationHandles)
      .values(
        missing.map((conversationId) => ({ id: newHandle(), entityId, channel, conversationId })),
      )
      .onConflictDoNothing();
    const rows = await db
      .select({ id: conversationHandles.id, conversationId: conversationHandles.conversationId })
      .from(conversationHandles)
      .where(
        and(
          eq(conversationHandles.entityId, entityId),
          eq(conversationHandles.channel, channel),
          inArray(conversationHandles.conversationId, missing),
        ),
      );
    for (const r of rows) found.set(r.conversationId, r.id as ConversationHandle);
    if (found.size === wanted.length) return found;
  }
  throw new Error(
    `conversation_handle_unavailable: ${wanted.length - found.size} ${channel} conversation(s) ` +
      'still have no handle after 3 attempts.',
  );
}

/** Le handle d'UNE conversation (`conversationHandlesFor` pour un seul identifiant). */
export async function conversationHandleFor(
  db: AnyDrizzleDb,
  params: { entityId: string | null; channel: string; conversationId: string },
): Promise<ConversationHandle> {
  const handles = await conversationHandlesFor(db, {
    entityId: params.entityId,
    channel: params.channel,
    conversationIds: [params.conversationId],
  });
  const handle = handles.get(params.conversationId);
  if (handle === undefined) {
    // conversationHandlesFor rend toutes les conversations demandées ou lève.
    throw new Error('conversation_handle_unavailable: no handle returned');
  }
  return handle;
}

/**
 * Les conversations que ces handles nomment DANS cette entité. Un handle d'une
 * autre entité, ou qui n'existe pas, n'a pas d'entrée : l'appelant le dit.
 */
export async function conversationsOfHandles(
  db: AnyDrizzleDb,
  params: { entityId: string | null; handles: Iterable<string> },
): Promise<Map<string, HandledConversation>> {
  const out = new Map<string, HandledConversation>();
  const handles = [...new Set(params.handles)].filter(isConversationHandle);
  if (!params.entityId || handles.length === 0) return out;
  const rows = await db
    .select({
      id: conversationHandles.id,
      channel: conversationHandles.channel,
      conversationId: conversationHandles.conversationId,
    })
    .from(conversationHandles)
    .where(
      and(
        eq(conversationHandles.entityId, params.entityId),
        inArray(conversationHandles.id, handles),
      ),
    );
  for (const r of rows) out.set(r.id, { channel: r.channel, conversationId: r.conversationId });
  return out;
}

/** La conversation qu'UN handle nomme dans cette entité, ou null. */
export async function resolveConversationHandle(
  db: AnyDrizzleDb,
  params: { entityId: string | null; handle: string },
): Promise<HandledConversation | null> {
  const map = await conversationsOfHandles(db, {
    entityId: params.entityId,
    handles: [params.handle],
  });
  return map.get(params.handle) ?? null;
}

/**
 * Ce qu'une PERSONNE lit là où un modèle a lu des handles : la même valeur,
 * chaque handle de cette entité remplacé par la conversation qu'il nomme. UNE
 * lecture pour tous les handles de la valeur. Les écrans qui montrent ce qu'un
 * modèle a écrit (le fil d'un run, une demande d'approbation) passent par ici.
 */
export async function showConversationsTo<T>(
  db: AnyDrizzleDb,
  entityId: string | null,
  value: T,
): Promise<T> {
  const handles = conversationHandlesIn(value);
  if (handles.size === 0) return value;
  return showConversationHandles(value, await conversationsOfHandles(db, { entityId, handles }));
}
