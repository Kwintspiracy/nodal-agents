'use client';

// SpokenAnnouncements — what the agent SAYS when a job launched by voice
// finishes, heard on whatever dashboard page is open (#967).
//
// A voice-launched task runs a minute or two; nobody stays on the conversation
// page for that. The owner's test of 2026-11-04: he asked for research by
// voice, went to the settings while it ran, the conversation's event stream
// closed with the page, and when the job finished the runner found no listener
// and said nothing. So the player lives in the dashboard SHELL (the layout),
// mounted once per tab: it listens to the workspace's event stream (no
// conversation filter, `GET /api/events`) for `reply.audio`, the pointer the
// runner pushes right after the job's `job.finished`, and plays the voice
// behind it (`playJobReply`) after the voice already playing, never over it.
// One player per tab: the conversation page only re-reads
// (`ConversationEvents`), it does not play.
//
// The dashboard closed entirely: nothing is said, and nothing is replayed
// later. The result is in the conversation, written.

import { useEffect } from 'react';
import { toast } from 'sonner';
import { playJobReply } from './chat/job-reply-voice.ts';

/** How many finished jobs' replies are kept for the "Speaking" pill of the voice that follows. */
const REPLIES_KEPT = 50;

function dataOf(e: MessageEvent): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(String(e.data));
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export default function SpokenAnnouncements() {
  useEffect(() => {
    const source = new EventSource('/api/events');
    // The result each finished job carries: the thread shows it, and the
    // "Speaking" pill marks it while its announcement plays.
    const replies = new Map<string, string>();
    const leaving = new AbortController();
    source.addEventListener('job.finished', (e) => {
      const data = dataOf(e);
      if (typeof data?.['jobId'] !== 'string' || typeof data['reply'] !== 'string') return;
      replies.set(data['jobId'], data['reply']);
      if (replies.size > REPLIES_KEPT) replies.delete(replies.keys().next().value!);
    });
    source.addEventListener('reply.audio', (e) => {
      const data = dataOf(e);
      const audioId = data?.['audioId'];
      const jobId = data?.['jobId'];
      if (typeof audioId !== 'string' || typeof jobId !== 'string') return;
      const reply = replies.get(jobId) ?? '';
      replies.delete(jobId);
      void playJobReply({
        audioId,
        reply,
        signal: leaving.signal,
        onFailed: (f) => toast.error(f.text, f.detail ? { description: f.detail } : undefined),
      });
    });
    source.onerror = () => {
      // CONNECTING: the browser is already retrying. CLOSED: it gave up (the
      // proxy or the runner refused): said, and announcements are not heard.
      if (source.readyState === EventSource.CLOSED) {
        console.warn('[SpokenAnnouncements] the event stream closed; announcements are not heard');
      }
    };
    return () => {
      leaving.abort();
      source.close();
    };
  }, []);

  return null;
}
