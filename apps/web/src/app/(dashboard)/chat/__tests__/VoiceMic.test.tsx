// VoiceMic.test.tsx — le micro push-to-talk du composeur (#942), état par état.
//
// Monté DANS `ThreadComposer`, là où il vit, et tenu comme une personne le
// tient : appui, glissade, relâche, barre d'espace. Le micro du navigateur est
// remplacé par une prise factice qui rend les morceaux qu'on lui donne ; les
// routes sont le `fetch` du navigateur, enregistré. Les assertions portent sur
// ce qui est ARRIVÉ (l'URL, la méthode et les octets de chaque requête, le
// texte et le nom des boutons à l'écran), jamais sur un nombre d'appels
// (invariant #5). Les phrases sont écrites EN DUR : un test qui lirait la
// constante du composant resterait vert quand on la change.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import { stopSpeaking } from '../voice-playback.ts';
import { MicrophoneError } from '@/lib/mic-capture.ts';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  sendChatMessageAction: vi.fn(async () => ({ ok: true as const })),
  setAgentModelAndEffortAction: vi.fn(async () => ({ ok: true as const })),
  listKeyModelsAction: vi.fn(async () => ({ ok: true as const, data: [] })),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/** La prise factice : elle garde les rappels pour que le test parle à sa place. */
const mic = vi.hoisted(() => ({
  handlers: null as null | {
    onChunk: (pcm: Uint8Array) => void;
    onLevel: (level: number) => void;
  },
  /** Ce que la prise rend en DERNIER morceau quand on la ferme. */
  tail: null as Uint8Array | null,
  stopped: false,
  refuse: null as Error | null,
  /** Tant qu'elle n'est pas tenue, le micro « s'ouvre » (invite de permission, worklet). */
  gate: null as Promise<void> | null,
}));
vi.mock('@/lib/mic-capture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mic-capture.ts')>();
  return {
    ...actual,
    startPcmCapture: async (handlers: {
      onChunk: (pcm: Uint8Array) => void;
      onLevel: (level: number) => void;
    }) => {
      if (mic.gate) await mic.gate;
      if (mic.refuse) throw mic.refuse;
      mic.handlers = handlers;
      return {
        sampleRate: 16_000,
        stop: () => {
          if (mic.stopped) return;
          mic.stopped = true;
          if (mic.tail) handlers.onChunk(mic.tail);
        },
      };
    },
  };
});

type Sent = { method: string; url: string; body: number[] | unknown };
let sent: Sent[];
/** La réponse de `end`, que chaque test règle (et peut retenir). */
let endReply: () => Promise<Response>;
let startReply: () => Response;
let chunkReply: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readBody(init: RequestInit | undefined): Promise<number[] | unknown> {
  const b = init?.body;
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') return JSON.parse(b) as unknown;
  return [...new Uint8Array(await new Response(b).arrayBuffer())];
}

/** Les lecteurs audio créés par la page, avec ce qu'on leur a demandé. */
let audios: { src: string; played: boolean; paused: boolean; ended: () => void }[];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  audios = [];
  mic.handlers = null;
  mic.tail = null;
  mic.stopped = false;
  mic.refuse = null;
  mic.gate = null;
  refresh.mockClear();
  startReply = () => json({ turnId: 'turn-1' }, 201);
  chunkReply = () => json({ received: 1 });
  endReply = async () => json({ outcome: 'nothing_heard', durationMs: 0 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      sent.push({ method, url, body: await readBody(init) });
      if (method === 'DELETE') return json({ cancelled: true });
      if (url === '/api/voice/turns') return startReply();
      if (url.includes('/chunks/')) return chunkReply();
      if (url.endsWith('/end')) return endReply();
      return json({ error: 'unexpected' }, 500);
    }),
  );
  vi.stubGlobal(
    'Audio',
    class {
      src: string;
      played = false;
      paused = false;
      private listeners = new Map<string, () => void>();
      constructor(src: string) {
        this.src = src;
        audios.push(this as unknown as (typeof audios)[number]);
      }
      get ended(): () => void {
        return () => this.listeners.get('ended')?.();
      }
      addEventListener(type: string, fn: () => void): void {
        this.listeners.set(type, fn);
      }
      play(): Promise<void> {
        this.played = true;
        return Promise.resolve();
      }
      pause(): void {
        this.paused = true;
      }
    },
  );
});

afterEach(async () => {
  await act(async () => {
    stopSpeaking();
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

/** Laisser passer les promesses en vol (fetch, prise, rendus). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function micButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-testid="composer-mic"]');
  if (!el) throw new Error('no microphone button rendered');
  return el;
}

function pointer(type: string, init: { x?: number; y?: number } = {}): Event {
  const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  return new Ctor(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.x ?? 10,
    clientY: init.y ?? 10,
    ...(Ctor === MouseEvent ? {} : { pointerId: 1 }),
  });
}

async function hold(): Promise<void> {
  await act(async () => {
    micButton().dispatchEvent(pointer('pointerdown'));
  });
  await settle();
}

async function releaseAt(x = 10, y = 10): Promise<void> {
  await act(async () => {
    micButton().dispatchEvent(pointer('pointermove', { x, y }));
    micButton().dispatchEvent(pointer('pointerup', { x, y }));
  });
  await settle();
}

function noteText(): string | null {
  return container.querySelector('[data-testid="voice-note"]')?.textContent ?? null;
}

function requests(): string[] {
  return sent.map((s) => `${s.method} ${s.url}`);
}

const WAV_BASE64 = 'UklGRiQAAABXQVZF';

describe('the chat microphone, state by state (#942) @cap:parler-a-un-agent/ecran', () => {
  it('idle: a round mic button named "Hold to talk", with the same hover tooltip', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    const button = micButton();
    expect(button.getAttribute('aria-label')).toBe('Hold to talk');
    expect(button.className).toContain('rounded-full');
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[data-testid="voice-tooltip"]')?.textContent).toBe(
      'Hold to talk',
    );
    // Placé entre la pastille du modèle et l'envoi : juste avant Send.
    const send = container.querySelector('[data-testid="composer-send"]');
    expect(button.closest('span')?.nextElementSibling).toBe(send);
  });

  it('listening: the textarea gives way to "Listening", a meter, a timer and the hint', async () => {
    await render(<ThreadComposer conversationId="conv-1" agentName="Alfred" />);
    await hold();

    const button = micButton();
    expect(button.getAttribute('aria-label')).toBe('Listening, release to send');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('bg-attention');
    const panel = container.querySelector('[data-testid="voice-listening"]');
    expect(panel?.textContent).toContain('Listening');
    expect(panel?.textContent).toContain('Release to send. Slide away to cancel.');
    expect(container.querySelector('[data-testid="voice-elapsed"]')?.textContent).toBe('0:00');
    expect(container.querySelectorAll('[data-testid="voice-meter"] > span')).toHaveLength(14);
    // La zone de texte est cachée, pas démontée.
    expect(container.querySelector('textarea')?.parentElement?.className).toContain('hidden');

    // Le niveau du micro fait bouger le dernier trait.
    await act(async () => {
      mic.handlers?.onLevel(0.2);
    });
    const bars = [...container.querySelectorAll<HTMLElement>('[data-testid="voice-meter"] > span')];
    expect(bars.at(-1)?.style.height).toBe('17px');
    expect(bars[0]?.style.height).toBe('4px');
  });

  it('listening: the timer counts the held seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(2026, 10, 3, 10, 0, 0));
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(container.querySelector('[data-testid="voice-elapsed"]')?.textContent).toBe('0:04');
  });

  it('chunks leave WHILE the button is held, in order, then `end` on release', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    expect(sent[0]).toEqual({
      method: 'POST',
      url: '/api/voice/turns',
      body: { conversationId: 'conv-1', format: 'audio/pcm', sampleRate: 16_000 },
    });

    await act(async () => {
      mic.handlers?.onChunk(new Uint8Array([1, 2, 3, 4]));
      mic.handlers?.onChunk(new Uint8Array([5, 6]));
    });
    await settle();
    // Le bouton est encore tenu : les deux morceaux sont déjà au runner.
    expect(micButton().getAttribute('aria-pressed')).toBe('true');
    expect(sent.slice(1)).toEqual([
      { method: 'POST', url: '/api/voice/turns/turn-1/chunks/0', body: [1, 2, 3, 4] },
      { method: 'POST', url: '/api/voice/turns/turn-1/chunks/1', body: [5, 6] },
    ]);

    mic.tail = new Uint8Array([7, 8]);
    await releaseAt();
    expect(sent.slice(3)).toEqual([
      { method: 'POST', url: '/api/voice/turns/turn-1/chunks/2', body: [7, 8] },
      { method: 'POST', url: '/api/voice/turns/turn-1/end', body: null },
    ]);
    expect(mic.stopped).toBe(true);
  });

  it('transcribing: "Transcribing…" in place of the textarea, the mic disabled', async () => {
    let answer: (r: Response) => void = () => {};
    endReply = () => new Promise<Response>((r) => (answer = r));
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();

    expect(container.querySelector('[data-testid="voice-transcribing"]')?.textContent).toBe(
      'Transcribing…',
    );
    const button = micButton();
    expect(button.getAttribute('aria-label')).toBe('Transcribing');
    expect(button.disabled).toBe(true);
    // Rien d'écrit ne part par-dessus le tour dit.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.disabled,
    ).toBe(true);

    await act(async () => {
      answer(json({ outcome: 'nothing_heard', durationMs: 0 }));
    });
    await settle();
    expect(container.querySelector('[data-testid="voice-transcribing"]')).toBeNull();
    expect(micButton().getAttribute('aria-label')).toBe('Hold to talk');
  });

  it('reply: the reply audio plays, Send becomes "Stop" ("Stop speaking"), and Stop stops it', async () => {
    endReply = async () =>
      json({
        outcome: 'replied',
        transcript: 'What is the capital of Australia?',
        durationMs: 3000,
        reply: 'Canberra.',
        spawnedJobId: null,
        stopped: false,
        cutReason: null,
        audio: { mimeType: 'audio/wav', base64: WAV_BASE64 },
        speechError: null,
      });
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();

    // Le fil est relu : il porte la transcription et la réponse.
    expect(refresh).toHaveBeenCalled();
    expect(audios).toHaveLength(1);
    expect(audios[0]?.src).toBe(`data:audio/wav;base64,${WAV_BASE64}`);
    expect(audios[0]?.played).toBe(true);
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-stop-speaking"]',
    );
    expect(stop?.getAttribute('aria-label')).toBe('Stop speaking');
    expect(stop?.textContent).toBe('Stop');
    expect(container.querySelector('[data-testid="composer-send"]')).toBeNull();

    await act(async () => {
      stop?.click();
    });
    expect(audios[0]?.paused).toBe(true);
    expect(container.querySelector('[data-testid="composer-stop-speaking"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-send"]')?.textContent).toBe('Send');
  });

  it('reply: when the audio ends by itself, Send comes back', async () => {
    endReply = async () =>
      json({
        outcome: 'replied',
        transcript: 'Hi',
        durationMs: 800,
        reply: 'Hello.',
        spawnedJobId: null,
        stopped: false,
        cutReason: null,
        audio: { mimeType: 'audio/wav', base64: WAV_BASE64 },
        speechError: null,
      });
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(container.querySelector('[data-testid="composer-stop-speaking"]')).not.toBeNull();
    await act(async () => {
      audios[0]?.ended();
    });
    expect(container.querySelector('[data-testid="composer-send"]')?.textContent).toBe('Send');
  });

  it('cancelled: released after sliding away, a DELETE is sent and nothing else', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await act(async () => {
      mic.handlers?.onChunk(new Uint8Array([1, 2]));
    });
    await settle();
    await releaseAt(10, 200);

    expect(noteText()).toBe('Cancelled. Nothing was sent.');
    expect(requests()).toEqual([
      'POST /api/voice/turns',
      'POST /api/voice/turns/turn-1/chunks/0',
      'DELETE /api/voice/turns/turn-1',
    ]);
    expect(mic.stopped).toBe(true);
    expect(micButton().getAttribute('aria-label')).toBe('Hold to talk');
  });

  it('cancelled: a slide that comes back over the button still sends', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await act(async () => {
      micButton().dispatchEvent(pointer('pointermove', { x: 10, y: 200 }));
    });
    await releaseAt(12, 14);
    expect(requests()).toContain('POST /api/voice/turns/turn-1/end');
    expect(requests()).not.toContain('DELETE /api/voice/turns/turn-1');
  });

  it('microphone blocked: a crossed mic and the note, no native dialog, and nothing sent', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    mic.refuse = new MicrophoneError('denied', 'Microphone access was refused.');
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();

    expect(noteText()).toBe(
      'Microphone blocked. Allow it for this site in your browser, then hold the button again.',
    );
    const button = micButton();
    expect(button.getAttribute('aria-label')).toBe('Microphone blocked');
    expect(button.disabled).toBe(false);
    expect(sent).toEqual([]);
    expect(alert).not.toHaveBeenCalled();

    // Le micro autorisé ensuite : le bouton redevient lui-même.
    mic.refuse = null;
    await hold();
    expect(micButton().getAttribute('aria-label')).toBe('Listening, release to send');
  });

  it('nothing heard: the route says `nothing_heard`, the composer says it', async () => {
    endReply = async () => json({ outcome: 'nothing_heard', durationMs: 0 });
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(noteText()).toBe('Nothing heard. Keep holding the button while you speak.');
  });

  it('the keyboard: Space held on the focused button talks, Escape cancels', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    const key = (type: string, k: string): Promise<void> =>
      act(async () => {
        micButton().dispatchEvent(
          new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }),
        );
      });

    await key('keydown', ' ');
    await settle();
    expect(micButton().getAttribute('aria-label')).toBe('Listening, release to send');
    await key('keyup', ' ');
    await settle();
    expect(requests()).toEqual(['POST /api/voice/turns', 'POST /api/voice/turns/turn-1/end']);

    sent = [];
    mic.stopped = false;
    startReply = () => json({ turnId: 'turn-2' }, 201);
    await key('keydown', ' ');
    await settle();
    await key('keydown', 'Escape');
    await settle();
    expect(noteText()).toBe('Cancelled. Nothing was sent.');
    expect(requests()).toEqual(['POST /api/voice/turns', 'DELETE /api/voice/turns/turn-2']);
  });
});

describe('the chat microphone says every route outcome (#942) @cap:parler-a-un-agent/ecran', () => {
  it('transcription_failed: said, nothing sent', async () => {
    endReply = async () => json({ error: 'transcription_failed', detail: 'provider 500' }, 502);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(noteText()).toBe('Could not transcribe what you said. Nothing was sent.');
    expect(container.querySelector('[data-testid="voice-note"]')?.getAttribute('title')).toBe(
      'provider 500',
    );
  });

  it('speechError: the reply is kept (the thread is re-read) and the voice failure is said', async () => {
    endReply = async () =>
      json({
        outcome: 'replied',
        transcript: 'Hi',
        durationMs: 900,
        reply: 'Hello.',
        spawnedJobId: null,
        stopped: false,
        cutReason: null,
        audio: null,
        speechError: { code: 'speech_failed', detail: 'tts 500' },
      });
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(refresh).toHaveBeenCalled();
    expect(audios).toEqual([]);
    expect(noteText()).toBe(
      'The reply is written above, but it could not be spoken (speech_failed).',
    );
  });

  it('413 on a chunk: listening stops at once and the note says it was too long', async () => {
    chunkReply = () => json({ error: 'audio_too_long' }, 413);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await act(async () => {
      mic.handlers?.onChunk(new Uint8Array([1, 2]));
    });
    await settle();
    // Toujours tenu, mais le tour est fini : le micro est rendu.
    expect(mic.stopped).toBe(true);
    expect(noteText()).toBe('That was too long to send. Nothing was sent.');
    expect(requests()).not.toContain('POST /api/voice/turns/turn-1/end');
  });

  it('refused auth at start: said, the mic stops, nothing else is sent', async () => {
    startReply = () => json({ error: 'unauthorized' }, 401);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    expect(noteText()).toBe('Voice was refused: not authorized. Nothing was sent.');
    expect(mic.stopped).toBe(true);
    expect(requests()).toEqual(['POST /api/voice/turns']);
  });

  it('no speech key: said before the person has spoken', async () => {
    startReply = () => json({ error: 'speech_not_configured' }, 409);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    expect(noteText()).toBe(
      'Voice needs an OpenRouter key. Add one in LLM Providers, then hold the button again.',
    );
  });

  it('a chat failure after the transcription is said in the chat words, and the thread re-read', async () => {
    endReply = async () => json({ error: 'agent_inactive' }, 400);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(noteText()).toBe('This conversation’s agent is disabled.');
    expect(refresh).toHaveBeenCalled();
  });
});

describe('the microphone on a screen whose conversation does not exist yet (P8, #942) @cap:parler-a-un-agent/ecran', () => {
  it('the press opens the conversation; a turn that wrote nothing gives it back', async () => {
    const onBeforeSend = vi.fn(async () => 'conv-new');
    const onSendFailed = vi.fn();
    const onSent = vi.fn();
    await render(
      <ThreadComposer
        conversationId=""
        onBeforeSend={onBeforeSend}
        onSendFailed={onSendFailed}
        onSent={onSent}
      />,
    );
    await hold();
    expect(sent[0]?.body).toEqual({
      conversationId: 'conv-new',
      format: 'audio/pcm',
      sampleRate: 16_000,
    });
    await releaseAt();
    expect(noteText()).toBe('Nothing heard. Keep holding the button while you speak.');
    expect(onSendFailed.mock.calls).toEqual([['conv-new']]);
    expect(onSent.mock.calls).toEqual([]);
  });

  it('a replied turn makes the screen become the new conversation', async () => {
    endReply = async () =>
      json({
        outcome: 'replied',
        transcript: 'Hi',
        durationMs: 900,
        reply: '',
        spawnedJobId: null,
        stopped: false,
        cutReason: null,
        audio: null,
        speechError: null,
      });
    const onSent = vi.fn();
    const onSendFailed = vi.fn();
    await render(
      <ThreadComposer
        conversationId=""
        onBeforeSend={async () => 'conv-new'}
        onSendFailed={onSendFailed}
        onSent={onSent}
      />,
    );
    await hold();
    await releaseAt();
    expect(onSent.mock.calls).toEqual([['conv-new']]);
    expect(onSendFailed.mock.calls).toEqual([]);
    expect(noteText()).toBeNull();
  });
});

describe('leaving the screen in the middle of a gesture (review of #964, pass 1) @cap:parler-a-un-agent/ecran', () => {
  it('while the mic is still opening: its tracks are stopped, no turn opens, no conversation is created', async () => {
    let grant: () => void = () => {};
    mic.gate = new Promise<void>((r) => (grant = r));
    const onBeforeSend = vi.fn(async () => 'conv-new');
    await render(
      <ThreadComposer conversationId="" onBeforeSend={onBeforeSend} onSendFailed={vi.fn()} />,
    );
    await hold();
    await act(async () => {
      root.unmount();
    });
    // La permission arrive APRÈS le départ de l'écran.
    await act(async () => {
      grant();
    });
    await settle();
    expect(mic.stopped).toBe(true);
    expect(requests()).toEqual([]);
    expect(onBeforeSend.mock.calls).toEqual([]);
  });

  it('while recording: the turn is cancelled with exactly one DELETE, and no end', async () => {
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await act(async () => {
      mic.handlers?.onChunk(new Uint8Array([1, 2]));
    });
    await settle();
    await act(async () => {
      root.unmount();
    });
    await settle();
    expect(mic.stopped).toBe(true);
    expect(requests()).toEqual([
      'POST /api/voice/turns',
      'POST /api/voice/turns/turn-1/chunks/0',
      'DELETE /api/voice/turns/turn-1',
    ]);
  });

  it('after the release: the turn the person sent is NOT cancelled, `end` goes through, nothing plays', async () => {
    let answer: (r: Response) => void = () => {};
    endReply = () => new Promise<Response>((r) => (answer = r));
    const onSent = vi.fn();
    await render(
      <ThreadComposer
        conversationId=""
        onBeforeSend={async () => 'conv-new'}
        onSendFailed={vi.fn()}
        onSent={onSent}
      />,
    );
    await hold();
    await releaseAt();
    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      answer(
        json({
          outcome: 'replied',
          transcript: 'Hi',
          durationMs: 900,
          reply: 'Hello.',
          spawnedJobId: null,
          stopped: false,
          cutReason: null,
          audio: { mimeType: 'audio/wav', base64: WAV_BASE64 },
          speechError: null,
        }),
      );
    });
    await settle();
    expect(requests()).toEqual(['POST /api/voice/turns', 'POST /api/voice/turns/turn-1/end']);
    // L'écran est parti : il ne revient pas sur la conversation, et rien ne parle.
    expect(onSent.mock.calls).toEqual([]);
    expect(audios).toEqual([]);
  });
});
