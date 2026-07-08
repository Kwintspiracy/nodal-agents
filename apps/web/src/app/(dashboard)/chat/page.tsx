import Link from 'next/link';
import { listConversationsAction } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import ChatClient from './ChatClient.tsx';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const res = await listConversationsAction();
  const data = res.ok ? res.data : { rootAgentId: null, rootName: null, conversations: [] };

  // Chat is a full-height surface, so it wears the shared header directly (the
  // one component every page uses) and keeps a viewport-filling body rather than
  // the centered PageShell body.
  if (!data.rootAgentId) {
    return (
      <>
        <PageHeader title="Chat" />
        <div className="flex h-[calc(100vh-13rem)] flex-col items-center justify-center gap-3 px-5 text-center sm:px-8 lg:px-9">
          <p className="text-sm text-ink-3">
            Designate a ROOT agent in Settings to chat with it here.
          </p>
          <Link
            href="/settings"
            className="inline-flex items-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
          >
            Go to Settings
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Chat" subtitle={data.rootName ? `with ${data.rootName}` : undefined} />
      <div className="flex h-[calc(100vh-9rem)] flex-col px-5 pt-4 pb-4 sm:px-8 lg:px-9">
        <ChatClient initialConversations={data.conversations} rootName={data.rootName} />
      </div>
    </>
  );
}
