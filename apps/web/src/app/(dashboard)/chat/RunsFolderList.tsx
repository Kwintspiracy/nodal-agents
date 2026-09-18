// RunsFolderList — la liste du dossier MCP (18/09/2026).
//
// La même boîte que les autres dossiers, le même composant de ligne. Ce qui
// change est ce qu'elle N'A PAS, et chaque absence est une décision :
//
//   - PAS de saisie et PAS de bouton « New conversation ». Un run venu de
//     dehors ne s'ouvre pas d'ici : c'est une machine qui le demande, par
//     `/api/agent` ou par le serveur MCP. Un bouton qui créerait une
//     conversation ici la rangerait dans « Nodal chats », pas dans ce dossier ;
//   - PAS de mode « Select » ni de suppression. Ces deux gestes agissent sur
//     des CONVERSATIONS (`deleteConversationsAction`) ; ces lignes sont des
//     runs, et rien ici ne peut les supprimer.
//
// Un composant à part de la page pour qu'il se rende dans jsdom avec ses
// lignes, sans base ni requête.

import ConversationRow from '@/components/ui/ConversationRow';
import EmptyState from '@/components/ui/EmptyState';
import type { ConversationRowModel } from './conversation-rows.ts';

export default function RunsFolderList({ rows }: { rows: ConversationRowModel[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No run started from outside Nodal yet." />;
  }

  return (
    // Pas d'écart entre les lignes : un trait les sépare dans une seule boîte,
    // et `overflow-hidden` fait suivre les coins arrondis à la première et à la
    // dernière — la même boîte que les dossiers de canal.
    <div
      className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="mcp-runs"
    >
      {rows.map(({ key, ...ligne }) => (
        <ConversationRow key={key} rowKey={key} {...ligne} />
      ))}
    </div>
  );
}
