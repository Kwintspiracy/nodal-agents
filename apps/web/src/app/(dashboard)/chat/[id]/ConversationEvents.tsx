'use client';

// ConversationEvents — the conversation re-reads the moment the runner says
// something changed for it (#944).
//
// The thread is rendered by the server from the rows, and `LiveRefresh` re-reads
// it every 3 s while work runs; the approvals under it come from the rail's
// 15 s poll (`ApprovalsProvider`). A finished job, a question or an approval
// therefore showed up to 15 s late. The runner now PUSHES those changes
// (`GET /api/events`, through the web proxy): this component listens for the
// conversation's events and re-reads at once, the thread (`router.refresh`) and
// the pending requests (`refresh`). The data path does not change: the rows
// stay the truth, the event only says "now".
//
// `EventSource` reconnects by itself and sends the last id it saw; the runner
// answers with what was missed, or `resync`, which re-reads the same way.
// `LiveRefresh` stays: it is the floor if the stream cannot be opened.
//
// A job launched by a spoken turn says its reply when it finishes (#967): the
// runner follows its `job.finished` with `reply.audio`, a pointer to the voice,
// and this component plays it (`playJobReply`) after the voice already
// playing, never over it. Only an open conversation page hears it: nothing is
// replayed later, the reply is in the thread as text.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useApprovals } from '@/components/ApprovalsProvider';
import { playJobReply } from '../job-reply-voice.ts';

/** The events that change what this page shows. `ready` changes nothing. */
export const CONVERSATION_REREAD_EVENTS = [
  'job.finished',
  'job.failed',
  'question.asked',
  'approval.requested',
  'approval.resolved',
  'resync',
] as const;

export default function ConversationEvents({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const { refresh } = useApprovals();

  useEffect(() => {
    const source = new EventSource(
      `/api/events?conversationId=${encodeURIComponent(conversationId)}`,
    );
    // A replay after a reconnection arrives as a burst: one re-read for all of it.
    let queued: ReturnType<typeof setTimeout> | null = null;
    const reread = (): void => {
      if (queued !== null) return;
      queued = setTimeout(() => {
        queued = null;
        router.refresh();
        void refresh();
      }, 0);
    };
    for (const type of CONVERSATION_REREAD_EVENTS) source.addEventListener(type, reread);

    // The reply each finished job carries, for the voice that follows it.
    const replies = new Map<string, string>();
    const leaving = new AbortController();
    const read = (e: MessageEvent): Record<string, unknown> | null => {
      try {
        const data: unknown = JSON.parse(String(e.data));
        return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    source.addEventListener('job.finished', (e) => {
      const data = read(e);
      if (typeof data?.['jobId'] === 'string' && typeof data['reply'] === 'string') {
        replies.set(data['jobId'], data['reply']);
      }
    });
    source.addEventListener('reply.audio', (e) => {
      const data = read(e);
      const audioId = data?.['audioId'];
      const jobId = data?.['jobId'];
      if (typeof audioId !== 'string' || typeof jobId !== 'string') return;
      void playJobReply({
        audioId,
        reply: replies.get(jobId) ?? '',
        signal: leaving.signal,
        onFailed: (f) => toast.error(f.text, f.detail ? { description: f.detail } : undefined),
      });
    });
    source.onerror = () => {
      // CONNECTING: the browser is already retrying. CLOSED: it gave up (the
      // proxy or the runner refused); said, and the page keeps its polling.
      if (source.readyState === EventSource.CLOSED) {
        console.warn(
          '[ConversationEvents] the event stream closed; the page falls back to polling',
        );
      }
    };
    return () => {
      if (queued !== null) clearTimeout(queued);
      leaving.abort();
      source.close();
    };
  }, [conversationId, router, refresh]);

  return null;
}
