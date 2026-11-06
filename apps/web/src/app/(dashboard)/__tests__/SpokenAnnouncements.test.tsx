// SpokenAnnouncements.test.tsx — the announcement of a finished voice job is
// heard on whatever dashboard page is open (#967).
//
// The owner's test of 2026-11-04: he asked for research by voice and went to
// the settings while it ran; the conversation page's stream closed with it,
// and nothing was said. The player now lives in the dashboard shell, on the
// workspace stream. What this proves, rendered in jsdom with the REAL playback
// (`voice-playback.ts`) on the fake AudioContext, which records what would be
// heard and when: the shell plays `reply.audio` with no conversation page open;
// with the conversation page open too, it plays ONCE; it plays after the voice
// already playing, never over it; Stop drops a waiting announcement; a failure
// is said in a toast. Only EventSource and `fetch` (the voice route) are
// stand-ins.
//
// Mutations verified (each turns a case red):
//   - the shell's `reply.audio` listener removed → "no conversation page open";
//   - `ConversationEvents` playing too (its #967 listener put back) → "once";
//   - `playJobReply` opening with `startSpokenStream` instead of
//     `queueSpokenStream` → "after the reply that is playing" (the ack is cut);
//   - `nextWaiting()` removed from `finishIfDone` → same case (never plays);
//   - `stopSpeaking` not clearing the queue → "Stop while it waits".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const refresh = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh, push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const listApprovalsAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  listApprovalsAction,
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));
vi.mock('@/lib/actions', () => ({
  listApprovalsAction,
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));

/** The browser's EventSource, as far as the components use it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown, id: string): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

const { toast } = await import('sonner');
const { startSpokenStream, stopSpeaking, useSpeaking } = await import('../chat/voice-playback.ts');
const { installFakeAudio, pcmBase64, sseBody } = await import('../chat/__tests__/fake-audio.ts');
const { ApprovalsProvider } = await import('@/components/ApprovalsProvider');
const { default: SpokenAnnouncements } = await import('../SpokenAnnouncements.tsx');
const { armSpokenAnnouncements } = await import('../chat/job-reply-voice.ts');
const { default: ConversationEvents } = await import('../chat/[id]/ConversationEvents.tsx');

let container: HTMLDivElement;
let root: Root;
let audio: ReturnType<typeof installFakeAudio>;
let fetchSpy: MockInstance<typeof fetch>;
/** What the voice route answers, per audio id. */
let voices: Map<string, () => Response>;

/** Two samples of 0.5 and -0.5, as the route sends them. */
const JOB_VOICE = pcmBase64([16384, -16384]);
/** Two samples of 0.25: the acknowledgement already playing. */
const ACK = new Uint8Array([0x00, 0x20, 0x00, 0x20]);

const SPOKEN_JOB: Array<[string, unknown]> = [
  ['audio', { seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, base64: JOB_VOICE }],
  ['audio_end', { sentence: 0, complete: true }],
  ['done', { text: 'The research is ready.', speechError: null }],
];

function voiceStream(events: Array<[string, unknown]>): () => Response {
  return () =>
    new Response(sseBody(events), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * The shell alone (any page but the conversation), or with the conversation
 * page, in a tab where the person has spoken (`arm`, the mic's press).
 */
async function render(withConversationPage = false, arm = true): Promise<void> {
  if (arm) armSpokenAnnouncements();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ApprovalsProvider initial={[]}>
        <SpokenAnnouncements />
        {withConversationPage ? <ConversationEvents conversationId="conv-1" /> : null}
      </ApprovalsProvider>,
    );
  });
  await flush();
}

const shell = (): FakeEventSource => FakeEventSource.all.find((s) => s.url === '/api/events')!;

/** What the runner pushes when the job ends, on every stream that reaches it. */
const finished = (jobId: string, reply: string) =>
  act(async () => {
    for (const source of FakeEventSource.all) {
      source.emit(
        'job.finished',
        { type: 'job.finished', jobId, conversationId: 'conv-1', reply },
        'b:1',
      );
      source.emit(
        'reply.audio',
        { type: 'reply.audio', jobId, conversationId: 'conv-1', audioId: `aud-${jobId}` },
        'b:2',
      );
    }
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.all = [];
  listApprovalsAction.mockReset();
  listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
  audio = installFakeAudio((name, value) => vi.stubGlobal(name, value));
  voices = new Map();
  vi.mocked(toast.error).mockReset();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const id = decodeURIComponent(url.split('/api/voice/replies/')[1] ?? '');
    const answer = voices.get(id);
    if (!answer) return Response.json({ error: 'reply_audio_not_found' }, { status: 404 });
    return answer();
  });
});

afterEach(() => {
  stopSpeaking();
  fetchSpy.mockRestore();
  act(() => root.unmount());
  container.remove();
});

describe('the announcement of a finished voice job is heard on any dashboard page (#967) @cap:parler-a-un-agent/ecran', () => {
  // FIRST in this file (its module state is its own): the tab has not spoken yet.
  it('before any voice turn in the tab: no stream is open (a page still finishes loading); the press opens it', async () => {
    await render(false, false);
    expect(FakeEventSource.all).toEqual([]);
    await act(async () => {
      armSpokenAnnouncements();
    });
    expect(FakeEventSource.all.map((s) => s.url)).toEqual(['/api/events']);
  });

  it('no conversation page open: the shell, on the workspace stream, plays it once, at once', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    await render();
    // The shell listens to the whole workspace, not to one conversation.
    expect(FakeEventSource.all.map((s) => s.url)).toEqual(['/api/events']);

    await finished('j1', 'The research report.');
    await flush();
    await flush();

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['/api/voice/replies/aud-j1']);
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, -0.5]]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('with the conversation page open too: it plays ONCE, the page only re-reads', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    await render(true);
    expect(FakeEventSource.all.map((s) => s.url).sort()).toEqual([
      '/api/events',
      '/api/events?conversationId=conv-1',
    ]);
    refresh.mockReset();

    await finished('j1', 'The research report.');
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, -0.5]]);
    // The conversation page still re-reads on job.finished.
    expect(refresh).toHaveBeenCalled();
  });

  it('after the reply that is playing: the playing one is never cut, the announcement follows it', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    const seen: Array<string | null> = [];
    function Probe() {
      seen.push(useSpeaking()?.reply ?? null);
      return null;
    }
    await render();
    const probe = createRoot(document.createElement('div'));
    await act(async () => {
      probe.render(<Probe />);
    });

    // The acknowledgement of the voice turn is playing.
    const ack = startSpokenStream({ reply: 'On it.', onError: () => {} });
    await act(async () => {
      ack.push({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: ACK });
      ack.end();
      await flush();
    });
    expect(audio.scheduled).toHaveLength(1);

    await finished('j1', 'The research report.');
    await flush();
    await flush();
    expect(audio.scheduled.map((s) => [s.samples, s.stopped])).toEqual([[[0.25, 0.25], false]]);
    expect(seen.at(-1)).toBe('On it.');

    // The acknowledgement ends: the announcement plays, once, after it, and
    // "Speaking" marks the job's result.
    audio.currentTime = 0.6;
    await act(async () => {
      audio.scheduled[0]!.finish();
      await flush();
    });
    await flush();
    expect(audio.scheduled.map((s) => [s.samples, s.stopped])).toEqual([
      [[0.25, 0.25], false],
      [[0.5, -0.5], false],
    ]);
    expect(audio.scheduled[1]!.at).toBeGreaterThanOrEqual(0.6);
    expect(seen.at(-1)).toBe('The research report.');
    await act(async () => {
      audio.scheduled[1]!.finish();
      await flush();
    });
    expect(audio.scheduled).toHaveLength(2);
    expect(seen.at(-1)).toBe(null);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      probe.unmount();
    });
  });

  it('Stop while it waits: it does not play, not even after the next voice', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    await render();
    const ack = startSpokenStream({ reply: 'On it.', onError: () => {} });
    await act(async () => {
      ack.push({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: ACK });
      await flush();
    });
    await finished('j1', 'The research report.');
    await flush();
    await flush();
    stopSpeaking();
    await flush();
    expect(audio.scheduled.map((s) => [s.samples, s.stopped])).toEqual([[[0.25, 0.25], true]]);

    // The next voice (the person speaks again) plays and ends: the dropped
    // announcement does not come back after it.
    const next = startSpokenStream({ reply: 'Next.', onError: () => {} });
    await act(async () => {
      next.push({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: ACK });
      next.end();
      await flush();
    });
    await act(async () => {
      audio.scheduled[1]!.finish();
      await flush();
    });
    await flush();
    expect(audio.scheduled.map((s) => s.samples)).toEqual([
      [0.25, 0.25],
      [0.25, 0.25],
    ]);
  });

  it('a voice that is gone, an announcement not written, a voice that failed: said in a toast', async () => {
    voices.set(
      'aud-j2',
      voiceStream([
        ['done', { text: null, speechError: { code: 'announcement_failed', detail: 'HTTP 500' } }],
      ]),
    );
    voices.set(
      'aud-j3',
      voiceStream([
        [
          'done',
          { text: 'Ready.', speechError: { code: 'voice_key_missing', detail: 'openrouter' } },
        ],
      ]),
    );
    await render();
    await finished('j1', 'Gone.');
    await flush();
    await finished('j2', 'Not written.');
    await flush();
    await finished('j3', 'No key.');
    await flush();
    await flush();
    expect(vi.mocked(toast.error).mock.calls).toEqual([
      [
        'The reply is written above, but it could not be spoken: its voice is no longer available.',
        undefined,
      ],
      [
        'The result is written above, but its spoken announcement could not be written.',
        { description: 'HTTP 500' },
      ],
      [
        'The reply is written above, but it could not be spoken: the voice has no key for its source. Add one in LLM Providers, or choose another voice in Settings.',
        { description: 'openrouter' },
      ],
    ]);
    expect(audio.scheduled).toEqual([]);
  });

  it('leaving the dashboard closes the workspace stream', async () => {
    await render();
    const source = shell();
    act(() => root.unmount());
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    root = createRoot(container);
  });
});
