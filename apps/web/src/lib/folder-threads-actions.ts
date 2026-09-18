'use server';

// folder-threads-actions.ts — ce qu'un dossier de la barre latérale DÉPLIE
// (Quentin, 18/09/2026).
//
// Chaque dossier du menu Channels porte un chevron : il montre ses cinq
// derniers fils, puis un « See all » qui ouvre sa liste. Ce ne sont pas
// d'autres lignes que celles de la liste — ce sont LES MÊMES, coupées aux
// premières, avec les mêmes titres et dans le même ordre. D'où cette lecture,
// qui ne fait qu'appeler celles de la page et regrouper leur résultat : écrire
// ici une seconde requête « les cinq derniers fils » aurait donné deux vérités
// pour le même sous-menu, et elles auraient divergé au premier correctif.
//
// ⚠️ POURQUOI UN MODULE À PART, et pas une action de plus dans
// `conversation-actions.ts`. Le regroupement a besoin de `groupChatLists`
// (lib/chat-list.ts), qui lit déjà le TYPE `ConversationListRow` de
// conversation-actions : l'y appeler aurait bouclé, et dependency-cruiser
// refuse un cycle, `import type` ou non (c'est la raison pour laquelle
// `chatKey` a son propre fichier).
//
// ⚠️ UNE SEULE LECTURE POUR TOUS LES DOSSIERS, jamais une par dossier. Les
// quatre appels ci-dessous couvrent l'ensemble du menu et partent en
// parallèle ; un dossier de plus ne coûte pas un aller-retour de plus. C'est
// la même discipline que `getChatFoldersAction`, et pour la même raison : le
// menu compte autant de dossiers que la personne a branché de canaux.

import 'server-only';
import { chatLabel, groupChatLists } from './chat-list.ts';
import {
  DASHBOARD_FOLDER,
  FOLDER_THREADS_MAX,
  MCP_FOLDER,
  folderThreads,
  type FolderThread,
  type FolderThreadSource,
} from './chat-folders.ts';
import { runIsRunning, runTitle } from './external-runs.ts';
import { truncate } from './format-time';
import { listApprovalsAction } from './actions.ts';
import {
  getChatFoldersAction,
  listAllConversationsAction,
  listChatNamesAction,
  listCurrentThreadByChatAction,
  listExternalRunsAction,
  type ActionResult,
} from './conversation-actions.ts';

/** Les fils dépliables de chaque dossier. Une clé absente = rien à déplier. */
export type FolderThreadsSnapshot = Readonly<Record<string, readonly FolderThread[]>>;

/** La même borne que les lignes de « Nodal chats » : le CSS coupe le reste. */
const TITLE_MAX = 120;

/**
 * Les cinq derniers fils de chaque dossier du menu.
 *
 * L'ordre de chaque dossier est celui de sa liste — le plus récent d'abord,
 * tel que les lectures le rendent. Rien n'est retrié : le sous-menu doit
 * montrer exactement la tête de la liste que « See all » ouvre.
 *
 * UN ÉCHEC EMPORTE TOUT, et se dit. Rendre les dossiers lisibles et taire les
 * autres afficherait un menu où « aucun fil » et « impossible de lire » se
 * ressemblent trait pour trait (invariant #4).
 */
export async function listFolderThreadsAction(): Promise<ActionResult<FolderThreadsSnapshot>> {
  const [conversations, names, currents, runs, approvals, folders] = await Promise.all([
    listAllConversationsAction(),
    listChatNamesAction(),
    listCurrentThreadByChatAction(),
    // Cinq suffisent : c'est tout ce que le sous-menu déplie, et le dossier
    // MCP n'a pas de « See all » d'une autre forme que les autres.
    listExternalRunsAction({ limit: FOLDER_THREADS_MAX }),
    // Ce qui ATTEND la personne, et OÙ ÇA TOURNE — les deux signaux du point
    // de chaque fil (19/09/2026). Les MÊMES lectures que la pastille et le
    // point vert du dossier, rangées par fil au lieu de l'être par dossier :
    // une par fil aurait été un aller-retour par ligne du menu.
    listApprovalsAction({ status: 'pending' }),
    getChatFoldersAction(),
  ]);

  if (!conversations.ok) return conversations;
  if (!names.ok) return names;
  if (!currents.ok) return currents;
  if (!runs.ok) return runs;
  if (!approvals.ok) return approvals;
  if (!folders.ok) return folders;

  const { channels, dashboard } = groupChatLists(
    conversations.data,
    names.data,
    currents.data.current,
    currents.data.listable,
  );

  // Les conversations sur lesquelles quelque chose attend. Une demande sans
  // conversation ne se pose sur AUCUN fil : elle vient d'une tâche de l'API ou
  // d'une automation, et lui choisir une ligne inventerait sa provenance.
  const attendSurFil = new Set(
    approvals.data.map((a) => a.conversationId).filter((id): id is string => id !== null),
  );
  // Et les runs de tête sur lesquels quelque chose attend : une question posée
  // par un délégué remonte à la ligne du run qui l'a lancé.
  const attendSurRun = new Set(
    approvals.data.map((a) => a.rootJobId).filter((id): id is string => id !== null),
  );
  const tourne = new Set(folders.data.runningConversationIds);

  const rows: FolderThreadSource[] = [];

  for (const c of channels) {
    // Un chat dont la base n'a désigné AUCUN fil courant n'ouvre rien. Sa
    // ligne existe dans la liste du dossier, qui dit à côté d'elle pourquoi
    // elle ne mène nulle part ; un raccourci du menu qui ne mène nulle part,
    // lui, n'est pas un raccourci. Il est donc absent du sous-menu, et jamais
    // remplacé par un lien inventé (invariant #4).
    const id = c.currentConversationId;
    if (id === null) continue;
    rows.push({
      folder: c.channel,
      key: c.key,
      title: chatLabel(c),
      href: `/chat/${id}`,
      waiting: attendSurFil.has(id),
      running: tourne.has(id),
    });
  }

  for (const c of dashboard) {
    rows.push({
      folder: DASHBOARD_FOLDER,
      key: c.id,
      // Le MÊME titre que la ligne de la liste (`conversationRows`) : déjà
      // masqué et coupé par la lecture (#179), « Untitled » quand personne ne
      // l'a nommé et que l'IA ne l'a pas encore renommé.
      title: c.title === '' ? 'Untitled' : truncate(c.title, TITLE_MAX),
      href: `/chat/${c.id}`,
      waiting: attendSurFil.has(c.id),
      running: tourne.has(c.id),
    });
  }

  for (const r of runs.data.runs) {
    rows.push({
      folder: MCP_FOLDER,
      key: r.id,
      title: runTitle(r.task),
      // Un run venu de dehors n'a pas de fil : sa ligne ouvre sa page, comme
      // dans la liste du dossier.
      href: `/jobs/${r.id}`,
      waiting: attendSurRun.has(r.id),
      // Un run sans conversation n'est dans aucun `runningConversationIds` :
      // c'est son STATUT qui dit s'il avance, la même règle que sa ligne dans
      // la liste du dossier.
      running: runIsRunning(r.status),
    });
  }

  return { ok: true, data: folderThreads(rows) };
}
