import Link from 'next/link';
import { listConversationsAction } from '@/lib/actions.ts';
import ChatClient from './ChatClient.tsx';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const res = await listConversationsAction();
  const data = res.ok ? res.data : { rootAgentId: null, rootName: null, conversations: [] };

  if (!data.rootAgentId) {
    return (
      <div className="flex h-[calc(100vh-7rem)] flex-col items-center justify-center gap-3 text-center">
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
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <ChatClient initialConversations={data.conversations} rootName={data.rootName} />
    </div>
  );
}
