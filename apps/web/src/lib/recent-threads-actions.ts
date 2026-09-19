'use server';

// recent-threads-actions.ts — la section « Recent » du panneau Talk (#230).
//
// La planche 4a montre, sous les dossiers de canaux, les cinq derniers fils
// TOUS CANAUX CONFONDUS, puis un « See all » vers la liste. C'est la seule
// chose du panneau qui regarde par-dessus les dossiers : un dossier répond à
// « où ça se passe », celle-ci à « qu'est-ce que je viens de faire ».
//
// ⚠️ UNE SEULE LECTURE BORNÉE, jamais une liste coupée à l'arrivée. Le plafond
// est en SQL (`recentConversationsQuery`), comme celui des sous-menus depuis la
// passe 1 de la revue de la PR #206.
//
// ⚠️ POURQUOI UN MODULE À PART, et pas une entrée de plus dans
// `folder-threads-actions.ts`. Les deux se ressemblent, mais ils ne partent pas
// au même moment : les sous-menus se chargent au PREMIER dépliage d'un dossier,
// « Recent » est visible dès que le panneau Talk s'affiche. Les fondre en un
// seul appel ferait payer les sous-menus à quelqu'un qui n'ouvre jamais de
// dossier, ou retarderait « Recent » jusqu'au premier clic.

import 'server-only';
import { RECENT_THREADS_MAX, type FolderThread } from './chat-folders.ts';
import { listApprovalsAction } from './actions.ts';
import {
  getChatFoldersAction,
  listRecentThreadReadsAction,
  type ActionResult,
} from './conversation-actions.ts';

/**
 * Les derniers fils, tous canaux confondus, dans l'ordre de la liste — le plus
 * récent d'abord, tel que la lecture le rend. Rien n'est retrié : « See all »
 * ouvre la même liste, et deux ordres sous le même nom se contrediraient.
 *
 * UN ÉCHEC EMPORTE TOUT, et se dit. Une section vide et une section illisible
 * se ressemblent trait pour trait (invariant #4).
 */
export async function listRecentThreadsAction(): Promise<ActionResult<readonly FolderThread[]>> {
  const [lignes, approvals, folders] = await Promise.all([
    listRecentThreadReadsAction(RECENT_THREADS_MAX),
    // Ce qui ATTEND la personne, et OÙ ÇA TOURNE : les deux signaux du point
    // d'un fil, avec le non-lu que la lecture rapporte déjà (#209).
    listApprovalsAction({ status: 'pending' }),
    getChatFoldersAction(),
  ]);

  if (!lignes.ok) return lignes;
  if (!approvals.ok) return approvals;
  if (!folders.ok) return folders;

  // Une demande sans conversation ne se pose sur AUCUN fil : elle vient d'une
  // tâche de l'API ou d'une automation, et lui choisir une ligne inventerait sa
  // provenance.
  const attend = new Set(
    approvals.data.map((a) => a.conversationId).filter((id): id is string => id !== null),
  );
  const tourne = new Set(folders.data.runningConversationIds);

  return {
    ok: true,
    data: lignes.data.map((r) => ({
      key: r.id,
      // Le MÊME titre que partout ailleurs : déjà masqué et coupé par la
      // lecture (#179), « Untitled » quand personne ne l'a nommé.
      title: r.title === '' ? 'Untitled' : r.title,
      href: `/chat/${r.id}`,
      waiting: attend.has(r.id),
      running: tourne.has(r.id),
      unread: r.unread,
    })),
  };
}
