// ConversationEvents.test.tsx — the conversation shows what the runner pushes
// as soon as it arrives (#944).
//
// Before: a new approval reached the thread on the rail's next 15 s poll, a
// finished job on LiveRefresh's next 3 s tick. What this proves, rendered in
// jsdom with the REAL provider (`ApprovalsProvider`) and the REAL card list
// (`ConversationApprovals`): when the stream says `approval.requested`, the card
// is on screen with no timer having run; when it says `job.finished` or
// `resync`, the thread is re-read; `ready` re-reads nothing; leaving the page
// closes the stream. Only `EventSource` (absent from jsdom) and the server
// actions are stand-ins.

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

/** The browser's EventSource, as far as the component uses it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** What the runner pushes, as the browser hands it to the page. */
  emit(type: string, data: unknown, id: string): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

const approval = (id: string) => ({
  id,
  jobId: 'j1',
  agentId: 'a1',
  agentName: 'Excel',
  agentSlug: 'excel',
  toolName: 'run_command',
  toolInput: { command: 'rm -rf out', purpose: 'Clear the stale build output.' },
  kind: 'approval',
  answer: null,
  status: 'pending',
  requestedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  expiresAt: null,
  notes: null,
  jobTask: null,
  jobChannel: 'dashboard',
  conversationId: 'conv-1',
  conversationChannel: 'dashboard',
  rootChannel: null,
  rootJobId: null,
  explanation: {
    what: 'Run a shell command',
    effect: 'external',
    effectLabel: 'Runs a command',
    target: null,
    provenance: { kind: 'builtin' },
    purpose: 'Clear the stale build output.',
    args: [],
    impact: null,
  },
  ruleChain: [],
  toolDefault: 'require_approval',
  agentWorkspaces: [],
  gateReasons: [],
});

const { toast } = await import('sonner');
const { startSpokenStream, stopSpeaking, useSpeaking } = await import('../voice-playback.ts');
const { installFakeAudio, pcmBase64, sseBody } = await import('./fake-audio.ts');
const { ApprovalsProvider } = await import('@/components/ApprovalsProvider');
const { default: ConversationApprovals } = await import('../[id]/ConversationApprovals.tsx');
const { default: ConversationEvents } = await import('../[id]/ConversationEvents.tsx');

let container: HTMLDivElement;
let root: Root;

/** Lets the coalesced re-read and the server actions' promises settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ApprovalsProvider initial={[]}>
        <ConversationEvents conversationId="conv-1" />
        <ConversationApprovals conversationId="conv-1" />
      </ApprovalsProvider>,
    );
  });
  await flush();
}

const cards = (): number => container.querySelectorAll('[data-testid="approval-card"]').length;

beforeEach(() => {
  refresh.mockReset();
  FakeEventSource.last = null;
  listApprovalsAction.mockReset();
  listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the conversation follows the push stream (#944) @cap:suivre-execution/ecran', () => {
  it("listens to THIS conversation's events, through the web proxy", async () => {
    await render();
    expect(FakeEventSource.last?.url).toBe('/api/events?conversationId=conv-1');
  });

  it('an approval.requested puts the card on screen at once, with no poll having run', async () => {
    await render();
    expect(cards()).toBe(0);

    // The runner has written the row and pushes it.
    listApprovalsAction.mockResolvedValue({ ok: true, data: [approval('ap-1')] });
    await act(async () => {
      FakeEventSource.last!.emit(
        'approval.requested',
        { type: 'approval.requested', approvalId: 'ap-1', jobId: 'j1', conversationId: 'conv-1' },
        'b:1',
      );
    });
    await flush();

    expect(cards()).toBe(1);
    expect(container.textContent).toContain('Clear the stale build output.');
  });

  it('an approval.resolved takes the card away once the rows say so', async () => {
    listApprovalsAction.mockResolvedValue({ ok: true, data: [approval('ap-1')] });
    await render();
    // The provider seeds from `initial` and polls later: the event is what reads.
    await act(async () => {
      FakeEventSource.last!.emit('approval.requested', { approvalId: 'ap-1' }, 'b:1');
    });
    await flush();
    expect(cards()).toBe(1);

    // Answered from another client: the row is no longer pending.
    listApprovalsAction.mockResolvedValue({ ok: true, data: [] });
    await act(async () => {
      FakeEventSource.last!.emit('approval.resolved', { approvalId: 'ap-1' }, 'b:2');
    });
    await flush();
    expect(cards()).toBe(0);
  });

  it('a job.finished, a job.failed or a resync re-reads the thread; ready does not', async () => {
    await render();
    await act(async () => {
      FakeEventSource.last!.emit('ready', {}, 'b:0');
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    for (const type of ['job.finished', 'job.failed', 'resync']) {
      refresh.mockReset();
      await act(async () => {
        FakeEventSource.last!.emit(type, { type }, 'b:1');
      });
      await flush();
      expect(refresh, type).toHaveBeenCalledTimes(1);
    }
  });

  it('a replayed burst is read once, not once per event', async () => {
    await render();
    await act(async () => {
      FakeEventSource.last!.emit('job.finished', {}, 'b:1');
      FakeEventSource.last!.emit('job.finished', {}, 'b:2');
      FakeEventSource.last!.emit('approval.resolved', {}, 'b:3');
    });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaving the conversation closes its stream', async () => {
    await render();
    const source = FakeEventSource.last!;
    act(() => root.unmount());
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    // afterEach unmounts again: give it a fresh root.
    root = createRoot(container);
  });
});

// #967 — a job launched by a spoken turn announces its end: its result stays
// written in the thread, and the agent's short announcement is SPOKEN. The
// runner follows the job's `job.finished` with `reply.audio`, a pointer; the
// page reads the voice behind it (`/api/voice/replies/:id`) and plays it AFTER
// the voice already playing, never over it. Rendered with the REAL playback
// (`voice-playback.ts`) on the fake AudioContext, which records what would be
// heard and when. Only `fetch` (the voice route) and EventSource are stand-ins.
//
// Mutations verified (each turns a case red):
//   - `playJobReply` opening with `startSpokenStream` instead of
//     `queueSpokenStream` → "after the reply that is playing" (the ack is cut);
//   - `nextWaiting()` removed from `finishIfDone` → same case (never plays);
//   - the `reply.audio` listener removed → "plays once, at once";
//   - `stopSpeaking` not clearing the queue → "Stop while it waits".
describe('the spoken reply of a finished job plays in its conversation (#967) @cap:parler-a-un-agent/ecran', () => {
  let audio: ReturnType<typeof installFakeAudio>;
  let fetchSpy: MockInstance<typeof fetch>;
  /** What the voice route answers, per audio id. */
  let voices: Map<string, () => Response>;

  /** Two samples of 0.5 and -0.5, as the route sends them. */
  const JOB_VOICE = pcmBase64([16384, -16384]);
  /** Two samples of 0.25: the acknowledgement already playing. */
  const ACK = new Uint8Array([0x00, 0x20, 0x00, 0x20]);

  function voiceStream(events: Array<[string, unknown]>): () => Response {
    return () =>
      new Response(sseBody(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
  }

  beforeEach(() => {
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
  });

  const finished = (jobId: string, reply: string) =>
    act(async () => {
      FakeEventSource.last!.emit('job.finished', { type: 'job.finished', jobId, reply }, 'b:1');
      FakeEventSource.last!.emit(
        'reply.audio',
        { type: 'reply.audio', jobId, conversationId: 'conv-1', audioId: `aud-${jobId}` },
        'b:2',
      );
    });

  const SPOKEN_JOB: Array<[string, unknown]> = [
    ['audio', { seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, base64: JOB_VOICE }],
    ['audio_end', { sentence: 0, complete: true }],
    ['done', { speechError: null }],
  ];

  it('nothing playing: the reply of the job plays once, at once, from the pointer', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    await render();
    await finished('j1', 'The buyout is the main story.');
    await flush();
    await flush();

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['/api/voice/replies/aud-j1']);
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, -0.5]]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('after the reply that is playing: the playing one is never cut, the job reply follows it', async () => {
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

    // The job finishes while it plays.
    await finished('j1', 'The buyout is the main story.');
    await flush();
    await flush();
    expect(audio.scheduled.map((s) => [s.samples, s.stopped])).toEqual([[[0.25, 0.25], false]]);
    expect(seen.at(-1)).toBe('On it.');

    // The acknowledgement ends: the job reply plays, once, after it.
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
    expect(seen.at(-1)).toBe('The buyout is the main story.');
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

  it('Stop while it waits: it does not play after the voice that was stopped', async () => {
    voices.set('aud-j1', voiceStream(SPOKEN_JOB));
    await render();
    const ack = startSpokenStream({ reply: 'On it.', onError: () => {} });
    await act(async () => {
      ack.push({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 4, bytes: ACK });
      await flush();
    });
    await finished('j1', 'The buyout is the main story.');
    await flush();
    await flush();
    stopSpeaking();
    await flush();
    expect(audio.scheduled.map((s) => [s.samples, s.stopped])).toEqual([[[0.25, 0.25], true]]);
  });

  it('a voice the runner no longer has, or one that failed, is said; the reply stays written', async () => {
    voices.set(
      'aud-j2',
      voiceStream([['done', { speechError: { code: 'voice_key_missing', detail: 'openrouter' } }]]),
    );
    await render();
    await finished('j1', 'Gone.');
    await finished('j2', 'No key.');
    await flush();
    await flush();
    expect(vi.mocked(toast.error).mock.calls).toEqual([
      [
        'The reply is written above, but it could not be spoken: its voice is no longer available.',
        undefined,
      ],
      [
        'The reply is written above, but it could not be spoken: the voice has no key for its source. Add one in LLM Providers, or choose another voice in Settings.',
        { description: 'openrouter' },
      ],
    ]);
    expect(audio.scheduled).toEqual([]);
  });

  it('an announcement the agent could not write is said as such; nothing plays', async () => {
    voices.set(
      'aud-j3',
      voiceStream([
        ['done', { text: null, speechError: { code: 'announcement_failed', detail: 'HTTP 500' } }],
      ]),
    );
    await render();
    await finished('j3', 'The result.');
    await flush();
    await flush();
    expect(vi.mocked(toast.error).mock.calls).toEqual([
      [
        'The result is written above, but its spoken announcement could not be written.',
        { description: 'HTTP 500' },
      ],
    ]);
    expect(audio.scheduled).toEqual([]);
  });
});
