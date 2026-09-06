import { listSpacesAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import ConversationsTable from './ConversationsTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
  // P9 : plus AUCUN run d'automatisation ici. `listSpacesAction` ne lit que
  // les conversations ; les runs cron vivent sur /scheduled.
  const result = await listSpacesAction();
  const conversations = result.ok ? result.data : [];

  return (
    <PageShell
      title="Spaces"
      subtitle="Every task as a conversation: what was asked, what the agent did, what came out."
    >
      {!result.ok ? (
        <p className="text-sm text-err">{result.message}</p>
      ) : conversations.length === 0 ? (
        <EmptyState
          title="No conversation yet"
          description="Ask an agent something from Chat or Telegram, and it shows up here."
        />
      ) : (
        <ConversationsTable rows={conversations} />
      )}
    </PageShell>
  );
}
