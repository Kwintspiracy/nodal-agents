'use server';

// folder-threads-actions.ts — ce qu'un dossier de la barre latérale DÉPLIE
// (Quentin, 18/09/2026).
//
// Chaque dossier du menu Channels porte un chevron : il montre ses cinq
// derniers fils, puis un « See all » qui ouvre sa liste. Ce ne sont pas
// d'autres lignes que celles de la liste — ce sont LES MÊMES, coupées aux
// premières, avec les mêmes titres et dans le même ordre.
//
// ⚠️ LE PLAFOND DE CINQ EST EN SQL, et il ne l'était pas (Reviewer C, passe 1
// de la PR #206). Ce module appelait `listAllConversationsAction`, qui ramène
// jusqu'à deux cents conversations avec leurs deux agrégats `array_agg`, puis
// coupait à cinq en TypeScript : le premier dépliage payait la page de liste
// entière pour quinze lignes. Il lit maintenant
// `listFolderThreadReadsAction`, deux requêtes BORNÉES
// (lib/folder-threads-sql.ts) qui ne rapportent que ce que le menu dessine.
//
// ⚠️ POURQUOI UN MODULE À PART, et pas une action de plus dans
// `conversation-actions.ts`. Le nommage d'un chat passe par `chatLabel`
// (lib/chat-list.ts), qui lit déjà le TYPE `ConversationListRow` de
// conversation-actions : l'y appeler aurait bouclé, et dependency-cruiser
// refuse un cycle, `import type` ou non (c'est la raison pour laquelle
// `chatKey` a son propre fichier).
//
// ⚠️ AUCUNE REQUÊTE PAR DOSSIER, ni par fil. Les appels ci-dessous partent en
// parallèle et couvrent l'ensemble du menu d'un coup : un canal branché demain
// ne coûte pas un aller-retour de plus. Ce n'est pas « une requête » — c'en
// est une poignée, chacune bornée — mais aucune ne se multiplie avec le
// nombre de dossiers ni avec celui des fils. C'est la même discipline que
// `getChatFoldersAction`, et pour la même raison.

import 'server-only';
import { chatKey, chatLabel } from './chat-list.ts';
import {
  DASHBOARD_FOLDER,
  FOLDER_THREADS_PROBE,
  MCP_FOLDER,
  folderThreads,
  type FolderThread,
  type FolderThreadSource,
} from './chat-folders.ts';
import { runIsRunning, runTitle } from './external-runs.ts';
import { listApprovalsAction } from './actions.ts';
import {
  getChatFoldersAction,
  listChatNamesAction,
  listCurrentThreadByChatAction,
  listExternalRunsAction,
  listFolderThreadReadsAction,
  type ActionResult,
} from './conversation-actions.ts';

/** Les fils dépliables de chaque dossier. Une clé absente = rien à déplier. */
export type FolderThreadsSnapshot = Readonly<Record<string, readonly FolderThread[]>>;

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
  const [lectures, names, currents, runs, approvals, folders] = await Promise.all([
    // Deux requêtes BORNÉES par dossier, le plafond en SQL — et UNE LIGNE DE
    // PLUS que ce que le menu dessine : sa présence est ce qui dit qu'il y en
    // a d'autres, donc qu'il faut un « See all ».
    listFolderThreadReadsAction(FOLDER_THREADS_PROBE),
    listChatNamesAction(),
    listCurrentThreadByChatAction(),
    // Le même plafond, sonde comprise : le dossier MCP n'a pas de « See all »
    // d'une autre forme que les autres.
    listExternalRunsAction({ limit: FOLDER_THREADS_PROBE }),
    // Ce qui ATTEND la personne, et OÙ ÇA TOURNE — les deux signaux du point
    // de chaque fil (19/09/2026). Les MÊMES lectures que la pastille et le
    // point vert du dossier, rangées par fil au lieu de l'être par dossier :
    // une par fil aurait été un aller-retour par ligne du menu.
    listApprovalsAction({ status: 'pending' }),
    getChatFoldersAction(),
  ]);

  if (!lectures.ok) return lectures;
  if (!names.ok) return names;
  if (!currents.ok) return currents;
  if (!runs.ok) return runs;
  if (!approvals.ok) return approvals;
  if (!folders.ok) return folders;

  // Les conversations sur lesquelles quelque chose attend. Une demande sans
  // conversation ne se pose sur AUCUN fil : elle vient d'une tâche de l'API ou
  // d'une automation, et lui choisir une ligne inventerait sa provenance.
  const attendSurFil = new Set([
    ...approvals.data.map((a) => a.conversationId).filter((id): id is string => id !== null),
    // ET LES FILS DONT UN LIVRABLE ATTEND UN REGARD (#255). La pastille du
    // dossier les compte ; sans cette ligne, elle afficherait un nombre
    // au-dessus de fils tous éteints, et rien ne dirait lequel ouvrir.
    ...folders.data.deliverableCheckConversationIds,
  ]);
  // Et les runs de tête sur lesquels quelque chose attend : une question posée
  // par un délégué remonte à la ligne du run qui l'a lancé.
  const attendSurRun = new Set([
    ...approvals.data.map((a) => a.rootJobId).filter((id): id is string => id !== null),
    // Même chose pour un run venu de dehors : son livrable attend, sa ligne le
    // dit.
    //
    // ⚠️ CETTE LISTE EST PLUS LARGE QUE LE DOSSIER MCP, et c'est sans effet.
    // Elle porte TOUT job de tête qui attend un regard, y compris ceux qui ont
    // une conversation — lesquels ne sont jamais des lignes de ce dossier
    // (`runsFromOutside` exige `conversation_id IS NULL`). Leur identifiant ne
    // rencontre donc aucune ligne, et il est inerte. Le commentaire disait
    // l'inverse — « ces identifiants sont déjà ceux des lignes du dossier
    // MCP » — ce qui énonçait une règle que le code n'applique pas (revue C,
    // passe 2, constat C5).
    ...folders.data.deliverableCheckJobIds,
  ]);
  const tourne = new Set(folders.data.runningConversationIds);

  const rows: FolderThreadSource[] = [];

  for (const c of lectures.data.chats) {
    // Un chat dont la base n'a désigné AUCUN fil courant n'ouvre rien. Sa
    // ligne existe dans la liste du dossier, qui dit à côté d'elle pourquoi
    // elle ne mène nulle part ; un raccourci du menu qui ne mène nulle part,
    // lui, n'est pas un raccourci. Il est donc absent du sous-menu, et jamais
    // remplacé par un lien inventé (invariant #4).
    const key = chatKey(c.agentId, c.channel, c.chatId);
    const id = currents.data.current[key];
    if (id === undefined) continue;
    const nom = names.data[`${c.channel}:${c.chatId}`];
    rows.push({
      folder: c.channel,
      key,
      // Le MÊME nom que la ligne de la liste, par la MÊME fonction : le `#`
      // d'un salon Discord, « Direct » pour un privé sans nom, l'identifiant
      // en dernier recours.
      title: chatLabel({
        channel: c.channel,
        chatId: c.chatId,
        name: nom?.name ?? null,
        kind: nom?.kind ?? null,
      }),
      href: `/chat/${id}`,
      waiting: attendSurFil.has(id),
      running: tourne.has(id),
      // Le non-lu du fil DÉSIGNÉ, lu par la même requête que la désignation :
      // c'est ce fil-là que le raccourci ouvre (#209).
      unread: currents.data.unread[key] ?? false,
    });
  }

  for (const c of lectures.data.conversations) {
    rows.push({
      folder: DASHBOARD_FOLDER,
      key: c.id,
      // Le MÊME titre que la ligne de la liste (`conversationRows`) : déjà
      // masqué, coupé ET nommé par la lecture (#179), « Untitled » compris.
      // Le dernier recours vit dans `nommerLesFils`, pas ici : il était écrit
      // à deux endroits, et deux copies du même repli finissent par diverger
      // (Reviewer C, passe 1 de la PR #235).
      title: c.title,
      href: `/chat/${c.id}`,
      waiting: attendSurFil.has(c.id),
      running: tourne.has(c.id),
      unread: c.unread,
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
      // JAMAIS non lu : un run venu de dehors n'a pas de conversation, donc pas
      // de marqueur de lecture. Hors du périmètre de #209, comme sa ligne de
      // liste (`run-rows.ts`).
      unread: false,
    });
  }

  return { ok: true, data: folderThreads(rows) };
}
