// /chat — la maison de TOUTES les conversations (P7).
//
// Le chat à deux volets a disparu avec cette page : une liste, et un fil par
// conversation (`/chat/[id]`), comme n'importe quelle application de
// messagerie. Les fils de canaux (Telegram, Slack, Discord, WhatsApp) sont
// ici au même titre que ceux du dashboard — c'est le même agent, et le canal
// n'est qu'un moyen d'y accéder.
//
// Depuis #135, la page s'ouvre aussi sur UN dossier (`?folder=telegram`,
// `?folder=dashboard`) : le menu de la barre latérale y mène, et c'est LÀ que
// la maquette dessine sa boîte de réception — une ligne par conversation,
// l'agent, le chat, le dernier mot, l'heure, et ce qui s'y passe.
//
// `?folder=mcp` est le seul qui ne liste PAS des conversations (18/09) : les
// runs lancés depuis dehors — `/api/agent`, le serveur MCP — n'en ont pas, et
// leurs lignes ouvrent la page du run. Même boîte, mêmes signes, même
// composant de ligne ; c'est ce qu'il y a DEDANS qui diffère.
//
// La page SANS dossier garde ses DEUX SECTIONS empilées — le tableau des chats
// de canal, puis les conversations de Nodal. Ce n'est pas un oubli : la vue
// entière mélange deux choses que la planche ne montre jamais ensemble, et
// décider de leur forme commune est une décision produit à part entière. Les
// conversations de Nodal, elles, s'y rendent comme dans leur dossier, par le
// même composant : deux formes des mêmes fils auraient divergé au premier
// correctif.

import PageShell from '@/components/ui/PageShell';
import ConversationRow from '@/components/ui/ConversationRow';
import EmptyState from '@/components/ui/EmptyState';
import {
  getChatFoldersAction,
  listAllConversationsAction,
  listChatNamesAction,
  listCurrentThreadByChatAction,
  listExternalRunsAction,
  type ExternalRunRow,
} from '@/lib/conversation-actions.ts';
import { listApprovalsAction } from '@/lib/actions.ts';
import { groupChatLists } from '@/lib/chat-list.ts';
import { folderOfWork, MCP_FOLDER } from '@/lib/chat-folders.ts';
import { chatFolderView, folderSubtitle } from './folder-view.ts';
import { conversationRows } from './conversation-rows.ts';
import ChannelChatsTable from './ChannelChatsTable.tsx';
import ChatListNotices from './ChatListNotices.tsx';
import ConversationsList from './ConversationsList.tsx';
import RunsFolderList from './RunsFolderList.tsx';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawFolder = params.folder;
  const folderParam = typeof rawFolder === 'string' ? rawFolder : null;
  // Les runs venus de dehors ne se lisent QUE dans leur dossier : les charger
  // sur la vue entière coûterait une requête à chaque ouverture de /chat pour
  // des lignes que personne ne regarde.
  const wantsRuns = folderParam === MCP_FOLDER;

  const [result, names, currents, folders, approvals, runsRead] = await Promise.all([
    listAllConversationsAction(),
    // Le nom des chats de canal. Une lecture qui échoue ne doit pas emporter la
    // page : les chats s'affichent alors par leur identifiant — mais elle se
    // DIT, voir `namesUnreadable`.
    listChatNamesAction(),
    // Le fil courant de chaque chat, désigné par la BASE avec la règle du
    // runner. Une lecture qui échoue n'emporte pas la page — mais elle se DIT :
    // voir `threadsUnreadable` ci-dessous.
    listCurrentThreadByChatAction(),
    // Les canaux qui EXISTENT, et les runs qui tournent — la même lecture que
    // le menu de la barre latérale, pour que les deux disent le même chiffre.
    getChatFoldersAction(),
    // Ce qui attend la personne. La barre latérale l'a déjà en main, mais elle
    // est cliente et cet en-tête est rendu par le serveur : c'est ce que coûte
    // la phrase. C'est la MÊME action et la MÊME attribution que le menu, pas
    // une seconde vérité.
    listApprovalsAction({ status: 'pending' }),
    wantsRuns ? listExternalRunsAction() : null,
  ]);
  const { channels, dashboard, missingCurrent, hiddenByWindow } = groupChatLists(
    result.ok ? result.data : [],
    names.ok ? names.data : {},
    currents.ok ? currents.data.current : {},
    currents.ok ? currents.data.listable : [],
  );

  // L'échec de la désignation se transmet TEL QUEL, sans passer par les lignes.
  // Quand la liste ne rapporte aucun canal — 200 conversations du dashboard
  // devant — et que cette lecture échoue, tous les compteurs valent zéro et la
  // section disparaissait : l'utilisateur ne pouvait pas distinguer « aucun chat
  // de canal » de « impossible de le vérifier » (revue Codex, PR #48, passe 11).
  const threadsUnreadable = !currents.ok;
  // Même règle pour les NOMS : sans eux, un chat s'affiche par son identifiant
  // et perd sa nature (privé, groupe). Rien ne distinguait cette panne d'un
  // chat qu'on n'a jamais nommé — le propriétaire, notamment, n'en a pas
  // (revue Codex, PR #48, passe 12).
  const namesUnreadable = !names.ok;

  // Le dossier demandé, VALIDÉ contre les canaux que la base connaît. Une
  // lecture des dossiers en échec laisse la page ENTIÈRE plutôt que de refuser
  // un dossier qui existe : c'est la vue la plus large, jamais la plus fausse.
  const view = chatFolderView(folderParam, folders.ok ? folders.data.channels : []);
  const shownChannels =
    view.channel === null ? channels : channels.filter((c) => c.channel === view.channel);

  // La PREMIÈRE page des runs venus de dehors (#183). `runsRead` vaut `null`
  // hors du dossier MCP — ce n'est PAS un échec, et le bandeau ne doit donc pas
  // s'allumer.
  const runs: ExternalRunRow[] = runsRead !== null && runsRead.ok ? runsRead.data.runs : [];
  const runsCursor = runsRead !== null && runsRead.ok ? runsRead.data.nextCursor : null;
  const runsUnreadable = runsRead !== null && !runsRead.ok;

  // Ce que la personne attend, rangé par la MÊME règle que le menu.
  const waitingHere = approvals.ok
    ? approvals.data.filter((a) => folderOfWork(a) === view.key).length
    : 0;

  // La phrase sous le titre d'un dossier. Trois chiffres, et QUE des chiffres
  // que la page tient : les conversations sont celles qu'elle affiche, les
  // attentes viennent des approbations rangées par la règle du menu, les runs
  // du même instantané.
  //
  // Le dossier MCP compte ses RUNS — TOUS, pas ceux de la page chargée (#183).
  // Depuis la pagination, « 50 runs » sous le titre d'un dossier qui en porte
  // cent dirait la taille d'une page, pas celle du dossier ; et le chiffre
  // changerait à chaque « Load more ». C'est le même compte que le menu, donc
  // le même que la barre latérale affiche à côté.
  const subtitle =
    view.key === null
      ? 'Your channels, and the conversations you started here.'
      : view.showRuns
        ? (folderSubtitle(
            {
              conversations: folders.ok ? folders.data.externalRuns : runs.length,
              waiting: waitingHere,
              running: folders.ok ? (folders.data.running[MCP_FOLDER] ?? 0) : 0,
            },
            'run',
          ) ?? undefined)
        : (folderSubtitle({
            conversations: view.showDashboard ? dashboard.length : shownChannels.length,
            waiting: waitingHere,
            running: folders.ok ? (folders.data.running[view.key] ?? 0) : 0,
          }) ?? undefined);

  // Ce qui se pose sur une ligne : les MÊMES approbations que le sous-titre et
  // que le menu — une seule lecture, une seule vérité — rangées par
  // conversation cette fois, pas par dossier.
  const signes = {
    waiting: approvals.ok ? approvals.data : [],
    runningConversationIds: folders.ok ? folders.data.runningConversationIds : [],
  };

  // Les lignes de la maquette, par la même règle et la même lecture pour tous
  // les dossiers : un canal montre ses chats, « Nodal chats » ses
  // conversations. Celles du dashboard se construisent AUSSI pour la vue
  // entière, qui rend la même liste : une seconde forme des mêmes fils aurait
  // divergé au premier correctif.
  const channelRows =
    view.key === null || !view.showChannels
      ? []
      : conversationRows({ chats: shownChannels, ...signes });
  const dashboardRows = view.showDashboard
    ? conversationRows({ conversations: dashboard, ...signes })
    : [];

  // Le dossier MCP se rend À PART, et AVANT le garde sur la liste des
  // conversations : il n'en lit aucune, et un échec de cette lecture-là ne doit
  // pas remplacer ses runs par un message d'erreur sans rapport.
  if (view.showRuns) {
    return (
      <PageShell title={view.title} subtitle={subtitle}>
        <ChatListNotices runsUnreadable={runsUnreadable} waitingUnreadable={!approvals.ok} />
        {/* Les LIGNES se construisent côté client, avec la même règle : c'est
            lui qui reçoit les pages suivantes, et deux constructions de la
            même ligne auraient divergé au premier correctif. Les attentes,
            elles, sont celles que la page a déjà lues — elles valent pour
            toutes les pages, une demande se rattachant à son job de tête. */}
        <RunsFolderList
          initialRuns={runs}
          initialCursor={runsCursor}
          waiting={approvals.ok ? approvals.data : []}
        />
      </PageShell>
    );
  }

  return (
    <PageShell title={view.title} subtitle={subtitle}>
      {result.ok ? (
        <>
          {/* Aucun bandeau ne se perd dans la refonte : ce que la page ne sait
              pas se dit AU-DESSUS de la liste, exactement comme le tableau le
              disait. Les deux derniers sont propres à la liste — sans eux,
              l'absence de point vert ou de pastille se lirait comme « rien ne
              se passe » alors que la lecture a échoué. Dans la vue entière,
              c'est `ChannelChatsTable` qui porte les quatre premiers. */}
          {view.key !== null && (
            <ChatListNotices
              threadsUnreadable={view.showChannels && threadsUnreadable}
              namesUnreadable={view.showChannels && namesUnreadable}
              missingCurrent={view.showChannels && missingCurrent}
              hiddenByWindow={view.showChannels ? hiddenByWindow : 0}
              waitingUnreadable={!approvals.ok}
              runningUnreadable={!folders.ok}
            />
          )}
          {view.showChannels &&
            (view.key === null ? (
              <ChannelChatsTable
                rows={shownChannels}
                threadsUnreadable={threadsUnreadable}
                namesUnreadable={namesUnreadable}
                missingCurrent={missingCurrent}
                hiddenByWindow={hiddenByWindow}
              />
            ) : channelRows.length === 0 ? (
              <EmptyState title="No conversation in this folder yet." />
            ) : (
              // Pas d'écart entre les lignes : la planche les sépare d'un
              // trait, dans une seule boîte. `overflow-hidden` fait suivre les
              // coins arrondis à la première et à la dernière.
              <div className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper">
                {channelRows.map(({ key, ...ligne }) => (
                  <ConversationRow key={key} rowKey={key} {...ligne} />
                ))}
              </div>
            ))}
          {/* « Nodal chats » : la même liste, et sa barre d'actions — créer,
              chercher, supprimer. Un dossier de CANAL n'en a pas : on n'y ouvre
              pas de conversation depuis le web, c'est la personne à l'autre
              bout qui écrit la première. */}
          {view.showDashboard && <ConversationsList rows={dashboardRows} />}
        </>
      ) : (
        <p className="text-sm text-err">{result.message}</p>
      )}
    </PageShell>
  );
}
