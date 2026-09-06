import { listSpacesAction } from '@/lib/actions.ts';
import { groupSpaces } from '@/lib/spaces-list.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import ConversationsTable from './ConversationsTable.tsx';
import ScheduledSection from './ScheduledSection.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
  const result = await listSpacesAction({ limit: 200 });
  const { conversations, scheduled } = groupSpaces(result.ok ? result.data : []);

  return (
    <PageShell
      title="Spaces"
      subtitle="Every task as a conversation: what was asked, what the agent did, what came out."
    >
      {!result.ok ? (
        <p className="text-sm text-err">{result.message}</p>
      ) : conversations.length === 0 && scheduled.length === 0 ? (
        <EmptyState
          title="No conversation yet"
          description="Ask an agent something from Chat, Telegram or an automation, and it shows up here."
        />
      ) : (
        <>
          {conversations.length === 0 ? (
            <EmptyState
              compact
              title="No conversation yet"
              description="Everything so far came from automations. They are listed below."
            />
          ) : (
            <ConversationsTable rows={conversations} />
          )}
          <ScheduledSection groups={scheduled} />
        </>
      )}
    </PageShell>
  );
}
