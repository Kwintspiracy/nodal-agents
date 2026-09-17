// ChatListNotices — ce que la page de chat ne SAIT PAS, dit en toutes lettres.
//
// Ces phrases vivaient dans `ChannelChatsTable`. La vue d'un dossier (#135) ne
// dessine plus ce tableau mais la liste de la maquette, et elle doit dire
// EXACTEMENT les mêmes choses : une lecture en échec qui se tait sous une
// nouvelle liste serait une régression silencieuse, pas une refonte. Une seule
// copie de chaque phrase, donc — deux se seraient mises à diverger.
//
// Chaque bandeau distingue un échec de LECTURE (on ne sait pas) d'un fait
// connu (ces chats existent, et n'ont pas de ligne). Confondre les deux est
// précisément ce qu'interdit l'invariant #4.

import { LIST_MAX } from '@/lib/chat-key.ts';

export type ChatListNoticesProps = {
  /** La base n'a pas pu désigner le fil courant d'au moins un chat affiché. */
  missingCurrent?: boolean;
  /** Des chats existent mais aucune de leurs conversations n'est dans la fenêtre. */
  hiddenByWindow?: number;
  /**
   * La lecture des fils courants a ÉCHOUÉ. Distinct de `missingCurrent`, qui
   * décrit des chats affichés : ici on ne sait rien, pas même s'il y a des
   * chats à montrer.
   */
  threadsUnreadable?: boolean;
  /**
   * La lecture des NOMS a échoué : les chats s'affichent par leur identifiant.
   * Distinct d'un chat sans nom connu — le propriétaire n'en a pas, et c'est
   * normal.
   */
  namesUnreadable?: boolean;
  /**
   * La lecture des runs en cours a échoué : AUCUN point vert n'est dessiné,
   * et l'absence de point ne veut donc plus dire « rien ne tourne » (#135).
   */
  runningUnreadable?: boolean;
  /**
   * La lecture des demandes en attente a échoué : aucune pastille « Question
   * asked » ni « Approval pending » n'est dessinée, même si l'une attend.
   */
  waitingUnreadable?: boolean;
};

export default function ChatListNotices({
  missingCurrent = false,
  hiddenByWindow = 0,
  threadsUnreadable = false,
  namesUnreadable = false,
  runningUnreadable = false,
  waitingUnreadable = false,
}: ChatListNoticesProps) {
  return (
    <>
      {threadsUnreadable && (
        <p className="text-body-12 text-err mb-2">
          Channel chats couldn’t be read just now. This list may be incomplete — reload to try
          again.
        </p>
      )}
      {namesUnreadable && (
        <p className="text-body-12 text-err mb-2">
          Chat names couldn’t be read just now — chats show their id instead. Reload to try again.
        </p>
      )}
      {waitingUnreadable && (
        <p className="text-body-12 text-err mb-2">
          Pending requests couldn’t be read just now — no row says it’s waiting for you, even if one
          is. Reload to try again.
        </p>
      )}
      {runningUnreadable && (
        <p className="text-body-12 text-err mb-2">
          Running work couldn’t be read just now — no row shows its green dot, even if a run is in
          progress. Reload to try again.
        </p>
      )}
      {missingCurrent && (
        <p className="text-body-12 text-ink-3 mb-2">
          Chats marked “unavailable” below can’t be opened right now — their current thread couldn’t
          be read. Reload in a moment.
        </p>
      )}
      {hiddenByWindow > 0 && (
        // La CAUSE n'est pas affirmée, parce qu'on ne la connaît pas : le
        // plafond en est une, un chat créé entre les deux lectures en est une
        // autre, et l'écran ne peut pas les distinguer (revue Codex, PR #48,
        // passe 10). Il dit ce qu'il SAIT — ces chats existent et n'ont pas de
        // ligne — et nomme le plafond comme la raison HABITUELLE, pas comme le
        // verdict.
        <p className="text-body-12 text-ink-3 mb-2">
          {hiddenByWindow} more {hiddenByWindow === 1 ? 'chat is' : 'chats are'} not shown here.
          Usually that means the list is full — it holds the {LIST_MAX} most recently active
          conversations. Reload to see the latest.
        </p>
      )}
    </>
  );
}
