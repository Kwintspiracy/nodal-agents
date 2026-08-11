import { listConversationsAction } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import JarvisClient from './JarvisClient.tsx';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  // Same source as the chat page: the ROOT agent, and whether it can speak.
  const res = await listConversationsAction();
  const data = res.ok
    ? res.data
    : { rootAgentId: null, rootName: null, rootHasVoice: false, rootVoiceStreams: false };

  return (
    <>
      <PageHeader title="Voice" subtitle={data.rootName ? `Talk to ${data.rootName}` : undefined} />
      <div className="flex h-[calc(100vh-9rem)] flex-col px-5 pt-4 pb-4 sm:px-8 lg:px-9">
        <JarvisClient
          agentId={data.rootAgentId}
          agentName={data.rootName}
          hasVoice={data.rootHasVoice}
          voiceStreams={data.rootVoiceStreams}
        />
      </div>
    </>
  );
}
