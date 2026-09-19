// folder-threads-sql.ts — les requêtes BORNÉES de la barre latérale
// (Reviewer C, passe 1 de la PR #206 ; une troisième depuis #230).
//
// POURQUOI ELLES EXISTENT. Le sous-menu ne montre que CINQ lignes par dossier,
// et il les prenait sur la lecture de la page de liste : jusqu'à deux cents
// conversations, avec leurs deux agrégats `array_agg`, puis une coupe à cinq
// en TypeScript. Le premier dépliage d'un dossier payait donc la page entière
// pour quinze lignes. Le plafond est maintenant EN SQL, et ce qui remonte est
// exactement ce que le menu dessine.
//
// TROIS requêtes, et pas une par dossier : la première rapporte les cinq
// derniers chats de CHAQUE canal d'un coup, par une fenêtre
// (`row_number() over (partition by channel …)`), la deuxième les cinq
// dernières conversations de « Nodal chats », la troisième les cinq derniers
// fils tous canaux confondus — la section « Recent » du panneau Talk (#230).
// Un canal branché demain ne coûte pas un aller-retour de plus.
//
// ⚠️ ELLES NE DÉSIGNENT PAS LE FIL COURANT d'un chat. Cette règle-là vit en un
// seul endroit — `listCurrentThreadByChatAction` — et la recopier ici, fût-ce
// en SQL, ferait deux vérités pour le fil qu'un clic ouvre (voir la note de
// cette action : la reconstituer a échoué deux fois).
//
// ⚠️ ELLES SONT DANS LEUR PROPRE FICHIER, hors de `conversation-actions.ts`,
// parce que celui-ci porte `'use server'` : un module d'actions n'exporte que
// des fonctions asynchrones, et un test qui veut LIRE la forme du SQL
// (`.toSQL()`) a besoin d'un constructeur ordinaire.

import {
  and,
  conversationReads,
  conversations,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from '@nodal-agents/db';
import { readsOfUser, unreadColumn } from './unread.ts';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/** Les origines qu'une liste de conversations montre. La même partout. */
const ORIGINES = ['user', 'project'] as const;

/**
 * Une conversation appartient-elle au dossier « Nodal chats » ?
 *
 * La MÊME règle que `groupChatLists` côté écran : celles du dashboard, et
 * celles qu'aucun chat ne porte — un canal sans `chat_id` ne se range dans
 * aucun dossier de canal, et disparaîtrait au lieu de tomber ici.
 */
function duDashboard() {
  return sql`(${conversations.channel} = 'dashboard' or ${conversations.chatId} is null or ${conversations.chatId} = '')`;
}

/**
 * LES CINQ DERNIERS CHATS DE CHAQUE CANAL, en une requête.
 *
 * Un chat est un triplet (agent, canal, interlocuteur) — la clé de `chatKey` —
 * et sa RÉCENCE est celle de sa conversation la plus fraîche, exactement comme
 * la ligne du dossier la lit. La fenêtre classe donc les chats DANS leur canal
 * et n'en garde que les premiers.
 *
 * ⚠️ L'ÉGALITÉ PARFAITE se départage ici par l'interlocuteur puis par l'agent,
 * là où la page départage par identifiant de conversation. Deux chats dont la
 * dernière activité tombe à la microseconde près peuvent donc sortir dans un
 * autre ordre qu'en bas de la page ; tout le reste est le même ordre. Un
 * départage est nécessaire — sans lui, le plan d'exécution choisirait, et le
 * menu changerait d'un chargement à l'autre.
 */
export function folderChatsQuery(db: Db, entityId: string, perFolder: number) {
  const chats = db
    .select({
      channel: conversations.channel,
      agentId: conversations.agentId,
      chatId: conversations.chatId,
      // `desc` NU, donc `NULLS FIRST` — le même ordre que la liste, qui trie
      // `updated_at DESC` sans préciser.
      rn: sql<number>`row_number() over (
        partition by ${conversations.channel}
        order by max(${conversations.updatedAt}) desc, ${conversations.chatId} desc, ${conversations.agentId} desc
      )`.as('rn'),
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.entityId, entityId),
        inArray(conversations.origin, [...ORIGINES]),
        ne(conversations.channel, 'dashboard'),
        isNotNull(conversations.chatId),
        ne(conversations.chatId, ''),
      ),
    )
    .groupBy(conversations.channel, conversations.agentId, conversations.chatId)
    .as('chats');

  return (
    db
      .select({ channel: chats.channel, agentId: chats.agentId, chatId: chats.chatId })
      .from(chats)
      .where(sql`${chats.rn} <= ${perFolder}`)
      // L'ORDRE SE DEMANDE, il ne s'espère pas. La requête englobante n'en
      // portait aucun : l'appelant ne retrie rien, et sans `order by` une base
      // rend ses lignes comme son plan l'arrange — l'ordre juste par chance
      // aujourd'hui, un autre le jour où un index change (Reviewer C, passe 2 de
      // la PR #206). Par canal puis par rang : chaque dossier reçoit ses lignes
      // groupées, et dans l'ordre de sa liste.
      .orderBy(chats.channel, chats.rn)
  );
}

/**
 * LES CINQ DERNIÈRES CONVERSATIONS DE « NODAL CHATS ».
 *
 * Pas de fenêtre : c'est un seul dossier, donc un `limit` suffit. Même ordre
 * que la liste — `updated_at` puis `id`, qui départage deux fils posés à la
 * même seconde.
 *
 * `userId` n'est là que pour le NON LU (#209) : les marqueurs de lecture
 * appartiennent à une personne, et la jointure en rapporte le sien. Une
 * jointure de plus dans la MÊME requête — jamais une lecture par fil.
 */
export function folderConversationsQuery(db: Db, entityId: string, userId: string, limit: number) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      channel: conversations.channel,
      unread: unreadColumn,
    })
    .from(conversations)
    .leftJoin(conversationReads, readsOfUser(userId))
    .where(
      and(
        eq(conversations.entityId, entityId),
        inArray(conversations.origin, [...ORIGINES]),
        duDashboard(),
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
}
