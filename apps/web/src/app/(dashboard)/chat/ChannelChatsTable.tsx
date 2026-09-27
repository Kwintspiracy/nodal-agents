// ChannelChatsTable — les CHATS de canal, une ligne chacun.
//
// Séparés des conversations du dashboard, et au-dessus d'elles, parce que ce
// sont deux objets différents : un chat ne se ferme jamais, ne se crée pas d'un
// bouton et ne se nettoie pas ; il est nommé par la personne ou le salon à
// l'autre bout, pas par ce qu'on y a dit en premier.
//
// Avant ce découpage, le chat Telegram de Quentin occupait à lui seul 45 lignes
// de la liste — une par fil ouvert au fil des mois — chacune titrée par son
// premier message, et le fil actif du matin s'appelait encore « Fais-moi une
// app en HTML, en récupérant l'API de IGDB », écrit dix jours plus tôt.
//
// Pas de sélection ni de suppression ici : on ne jette pas un interlocuteur.

import Table, { THead, Th, Tr, Td, CellAgent, CellText, CellMono } from '@/components/ui/Table';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime, truncate } from '@/lib/format-time';
import { chatLabel, type ChannelChatRow } from '@/lib/chat-list.ts';
import ChatListNotices from './ChatListNotices.tsx';

/** « telegram » → « Telegram ». Le canal, nommé comme l'utilisateur le nomme. */
function channelLabel(channel: string): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

export default function ChannelChatsTable({
  rows,
  missingCurrent = false,
  hiddenByWindow = 0,
  threadsUnreadable = false,
  namesUnreadable = false,
}: {
  rows: ChannelChatRow[];
  /** La base n'a pas pu désigner le fil courant d'au moins un chat. */
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
}) {
  // La section doit apparaître dès qu'elle a quelque chose à DIRE — des lignes,
  // des chats hors fenêtre, ou une lecture en échec. Sans le dernier cas, une
  // panne de la désignation faisait disparaître la section entière en silence
  // (revue Codex, PR #48, passe 11).
  if (rows.length === 0 && hiddenByWindow === 0 && !threadsUnreadable && !namesUnreadable)
    return null;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-body-13 font-medium text-ink">Channels</h2>
        <span className="text-mono-11 text-ink-4">
          {rows.length} {rows.length === 1 ? 'chat' : 'chats'}
        </span>
      </div>
      <ChatListNotices
        threadsUnreadable={threadsUnreadable}
        namesUnreadable={namesUnreadable}
        missingCurrent={missingCurrent}
        hiddenByWindow={hiddenByWindow}
      />
      <Table>
        <THead>
          <Th>Agent</Th>
          <Th>Chat</Th>
          <Th className="hidden md:table-cell">Channel</Th>
          <Th className="hidden lg:table-cell">Last message</Th>
          <Th align="right" className="hidden sm:table-cell">
            Threads
          </Th>
          <Th className="hidden lg:table-cell">Last activity</Th>
        </THead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.key}>
              <Td>
                <CellAgent name={r.agentName} imageUrl={r.agentAvatarUrl} />
              </Td>
              <Td>
                {/* Sans fil courant désigné, PAS de lien : on ne devine pas où
                    mène ce chat. Le nom reste lisible, et la bannière au-dessus
                    dit pourquoi il n'ouvre rien (invariant #4 — jamais un repli
                    silencieux qui présente une estimation comme un fait). */}
                {r.currentConversationId !== null ? (
                  <CellText href={`/chat/${r.currentConversationId}`}>{chatLabel(r)}</CellText>
                ) : (
                  // L'état est DIT sur la ligne, pas seulement suggéré par une
                  // nuance de gris et l'absence de lien : sur cinquante chats,
                  // il fallait sinon deviner lequel n'ouvre rien (revue Codex,
                  // PR #48, passe 8).
                  <div className="flex items-center gap-1.5">
                    <CellText>{chatLabel(r)}</CellText>
                    <MonoMicroTag tone="ink">unavailable</MonoMicroTag>
                  </div>
                )}
              </Td>
              <Td className="hidden md:table-cell">
                <MonoMicroTag tone="ink">{channelLabel(r.channel)}</MonoMicroTag>
              </Td>
              <Td className="hidden lg:table-cell">
                {r.lastPreview !== null && (
                  <CellText quiet clamp title={r.lastPreview}>
                    {truncate(r.lastPreview, 60)}
                  </CellText>
                )}
              </Td>
              <Td align="right" className="hidden sm:table-cell">
                <CellMono>{r.conversationCount}</CellMono>
              </Td>
              <Td className="hidden lg:table-cell">
                {r.updatedAt && <CellMono>{relativeTime(r.updatedAt)}</CellMono>}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
