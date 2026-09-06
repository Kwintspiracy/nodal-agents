// /chat — la maison de TOUTES les conversations (P7).
//
// Le chat à deux volets a disparu avec cette page : une liste, et un fil par
// conversation (`/chat/[id]`), comme n'importe quelle application de
// messagerie. Les fils de canaux (Telegram, Slack, Discord, WhatsApp) sont
// ici au même titre que ceux du dashboard — c'est le même agent, et le canal
// n'est qu'un moyen d'y accéder.

import PageShell from '@/components/ui/PageShell';
import { listAllConversationsAction } from '@/lib/conversation-actions.ts';
import ConversationsList from './ConversationsList.tsx';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const result = await listAllConversationsAction();

  return (
    <PageShell
      title="Chat"
      subtitle="Every conversation, from the dashboard and from your channels."
    >
      {result.ok ? (
        <ConversationsList rows={result.data} />
      ) : (
        <p className="text-sm text-err">{result.message}</p>
      )}
    </PageShell>
  );
}
