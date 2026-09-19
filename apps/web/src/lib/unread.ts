// unread.ts — CE QUE « NON LU » VEUT DIRE, et le seul endroit qui le dit (#209).
//
// Le produit ne gardait AUCUN état de lecture jusqu'au 19/09/2026. Le point
// d'un fil dans la barre latérale ne pouvait donc signifier que « quelque
// chose attend » ou « un run tourne », et la pastille « Unread » de la planche
// n'était pas dessinée : l'afficher aurait montré un fait que rien ne pouvait
// vérifier (invariant #4). La table `conversation_reads` (migration 0112) est
// ce qui manquait ; ce module en tire la règle.
//
// DEUX COLONNES, ET PAS UNE TROISIÈME. Une conversation porte un `updated_at`
// que chaque réponse d'agent et chaque message entrant avancent
// (apps/runner/src/chat/run-chat-turn.ts, apps/runner/src/job/conversation-id.ts).
// Un fil est NON LU quand ce temps dépasse le marqueur de la personne, ou
// qu'aucun marqueur n'existe.
//
// ⚠️ CE QUE « JAMAIS LU » VEUT DIRE, ET POURQUOI C'EST VOULU. Un fil qu'on n'a
// jamais ouvert ici n'a pas de marqueur, et il est donc NON LU. Tous les fils
// de la base le sont le jour de la migration. C'est la seule réponse honnête :
// dater un marqueur d'office à l'instant de la migration prétendrait que la
// personne a lu ce qu'elle n'a pas lu.
//
// ⚠️ LE MESSAGE DE LA PERSONNE ELLE-MÊME NE REND PAS SON FIL NON LU sur le
// tableau de bord : `updated_at` n'est avancé qu'APRÈS la réponse de l'agent,
// jamais à l'insertion du tour de l'utilisateur. Et le fil ouvert reste ouvert
// — la page se relit tant qu'un travail tourne, et chaque relecture repose le
// marqueur.
//
// ⚠️ CE MODULE NE FAIT AUCUNE REQUÊTE. Il rend la JOINTURE et la COLONNE que
// les lectures groupées existantes ajoutent chez elles. Une lecture par fil —
// « ce fil est-il non lu ? » — serait un aller-retour par ligne de liste et par
// ligne de menu, ce que ces lectures ont justement passé deux revues à retirer.

import { and, conversationReads, conversations, eq, sql } from '@nodal-agents/db';

/**
 * La condition de jointure des marqueurs D'UNE personne sur les conversations
 * de la requête courante.
 *
 * `leftJoin`, toujours : un fil sans marqueur doit rester dans la liste — c'est
 * précisément celui qui est non lu — et un `innerJoin` l'en ferait disparaître.
 *
 * Le type de retour est INFÉRÉ : le type `SQL` de drizzle n'appartient qu'à
 * `packages/db`, et l'écrire ici demanderait d'importer `drizzle-orm` depuis
 * `apps/web`, ce que dependency-cruiser refuse — à raison.
 */
export function readsOfUser(userId: string) {
  return and(
    eq(conversationReads.conversationId, conversations.id),
    eq(conversationReads.userId, userId),
  );
}

/**
 * La colonne `unread` d'une ligne de conversation, à sélectionner dans une
 * requête qui a joint `readsOfUser`.
 *
 * Écrite UNE fois : trois lectures la portent — la liste d'un dossier, le
 * sous-menu de la barre latérale, la désignation du fil courant d'un chat — et
 * trois copies de cette comparaison auraient fini par se contredire.
 */
export const unreadColumn = sql<boolean>`(${conversationReads.readAt} IS NULL OR ${conversations.updatedAt} > ${conversationReads.readAt})`;
