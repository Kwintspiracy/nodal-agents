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
//
// #943 : la fin du tour est un FLUX d'événements (transcript, delta, audio,
// done), écrit ici comme la route l'écrit ; la voix joue sur un AudioContext
// factice (`fake-audio.ts`) qui note ce qui aurait été entendu.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import { stopSpeaking } from '../voice-playback.ts';
import PendingTurn, { PendingTurnProvider } from '../PendingTurn.tsx';
import { MicrophoneError } from '@/lib/mic-capture.ts';
import { installFakeAudio, pcmBase64, sseBody } from './fake-audio.ts';

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

/** La fin d'un tour telle que la route l'écrit : un flux d'événements. */
function sse(events: Array<[string, unknown]>): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

/** Une fin de tour que le test écrit événement par événement, flux ouvert. */
function heldStream(): {
  response: Response;
  write: (event: string, data: unknown) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  // Comme un vrai `fetch` : la requête abandonnée coupe son corps.
  onEndAbort = () => controller.error(new DOMException('aborted', 'AbortError'));
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
    write: (event, data) => controller.enqueue(new TextEncoder().encode(sseBody([[event, data]]))),
    close: () => controller.close(),
  };
}

const DONE = {
  spawnedJobId: null,
  streamed: true,
  stopped: false,
  cutReason: null,
  speechError: null,
};

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

/** Ce que la voix aurait fait entendre (le faux AudioContext). */
let audio: ReturnType<typeof installFakeAudio>;
/** Le signal de la requête `end` : Stop l'abandonne. */
let endSignal: AbortSignal | null;
/** Ce que l'abandon de `end` fait au corps de sa réponse. */
let onEndAbort: (() => void) | null = null;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  endSignal = null;
  onEndAbort = null;
  mic.handlers = null;
  mic.tail = null;
  mic.stopped = false;
  mic.refuse = null;
  mic.gate = null;
  refresh.mockClear();
  startReply = () => json({ turnId: 'turn-1' }, 201);
  chunkReply = () => json({ received: 1 });
  endReply = async () => sse([['nothing_heard', { durationMs: 0 }]]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      sent.push({ method, url, body: await readBody(init) });
      if (method === 'DELETE') return json({ cancelled: true });
      if (url === '/api/voice/turns') return startReply();
      if (url.includes('/chunks/')) return chunkReply();
      if (url.endsWith('/end')) {
        endSignal = init?.signal ?? null;
        endSignal?.addEventListener('abort', () => onEndAbort?.());
        return endReply();
      }
      return json({ error: 'unexpected' }, 500);
    }),
  );
  audio = installFakeAudio(vi.stubGlobal);
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

/** La voix d'une phrase : trois échantillons PCM à 24 kHz. */
const VOICE = { seq: 0, mimeType: 'audio/pcm', sampleRate: 24_000, base64: pcmBase64([1, 2, 3]) };

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
      answer(sse([['nothing_heard', { durationMs: 0 }]]));
    });
    await settle();
    expect(container.querySelector('[data-testid="voice-transcribing"]')).toBeNull();
    expect(micButton().getAttribute('aria-label')).toBe('Hold to talk');
  });

  it('reply: the reply audio plays, Send becomes "Stop" ("Stop speaking"), and Stop stops it', async () => {
    endReply = async () =>
      sse([
        ['transcript', { transcript: 'What is the capital of Australia?', durationMs: 3000 }],
        ['delta', { text: 'Canberra.' }],
        ['audio', VOICE],
        ['done', { reply: 'Canberra.', ...DONE }],
      ]);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();

    // Le fil est relu : il porte la transcription et la réponse.
    expect(refresh).toHaveBeenCalled();
    expect(audio.scheduled.map((s) => s.samples.length)).toEqual([3]);
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-stop-speaking"]',
    );
    expect(stop?.getAttribute('aria-label')).toBe('Stop speaking');
    expect(stop?.textContent).toBe('Stop');
    expect(container.querySelector('[data-testid="composer-send"]')).toBeNull();

    await act(async () => {
      stop?.click();
    });
    expect(audio.scheduled[0]?.stopped).toBe(true);
    expect(container.querySelector('[data-testid="composer-stop-speaking"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-send"]')?.textContent).toBe('Send');
    // Le tour était fini : ce Stop ne demande rien au runner.
    expect(requests()).not.toContain('POST /api/chat/stop');
  });

  it('reply: when the audio ends by itself, Send comes back', async () => {
    endReply = async () =>
      sse([
        ['transcript', { transcript: 'Hi', durationMs: 800 }],
        ['delta', { text: 'Hello.' }],
        ['audio', VOICE],
        ['done', { reply: 'Hello.', ...DONE }],
      ]);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(container.querySelector('[data-testid="composer-stop-speaking"]')).not.toBeNull();
    await act(async () => {
      audio.scheduled[0]?.finish();
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
    endReply = async () => sse([['nothing_heard', { durationMs: 0 }]]);
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
      sse([
        ['transcript', { transcript: 'Hi', durationMs: 900 }],
        ['delta', { text: 'Hello.' }],
        [
          'done',
          { reply: 'Hello.', ...DONE, speechError: { code: 'speech_failed', detail: 'tts 500' } },
        ],
      ]);
    await render(<ThreadComposer conversationId="conv-1" />);
    await hold();
    await releaseAt();
    expect(refresh).toHaveBeenCalled();
    expect(audio.scheduled).toEqual([]);
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
    endReply = async () =>
      sse([
        ['transcript', { transcript: 'Hi', durationMs: 900 }],
        ['error', { error: 'agent_inactive' }],
      ]);
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
      sse([
        ['transcript', { transcript: 'Hi', durationMs: 900 }],
        ['done', { reply: '', ...DONE }],
      ]);
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
        sse([
          ['transcript', { transcript: 'Hi', durationMs: 900 }],
          ['delta', { text: 'Hello.' }],
          ['audio', VOICE],
          ['done', { reply: 'Hello.', ...DONE }],
        ]),
      );
    });
    await settle();
    expect(requests()).toEqual(['POST /api/voice/turns', 'POST /api/voice/turns/turn-1/end']);
    // L'écran est parti : il ne revient pas sur la conversation, et rien ne parle.
    expect(onSent.mock.calls).toEqual([]);
    expect(audio.scheduled).toEqual([]);
  });
});

describe('the spoken reply arrives as it is written (#943) @cap:parler-a-un-agent/ecran', () => {
  async function renderThread(): Promise<void> {
    await render(
      <PendingTurnProvider requests={[]} awaitingReply={false}>
        <PendingTurn agentName="Alfred" />
        <ThreadComposer conversationId="conv-1" />
      </PendingTurnProvider>,
    );
  }

  it('the transcript appears with "Spoken · 0:03", the reply streams into it, and the voice plays before the end', async () => {
    const held = heldStream();
    endReply = async () => held.response;
    await renderThread();
    await hold();
    await releaseAt();
    expect(container.querySelector('[data-testid="voice-transcribing"]')).not.toBeNull();

    await act(async () => {
      held.write('transcript', {
        transcript: 'What is the capital of Australia?',
        durationMs: 3000,
      });
    });
    await settle();
    // Le geste est fini : la saisie revient, et la demande dite est dans le fil.
    expect(container.querySelector('[data-testid="voice-transcribing"]')).toBeNull();
    expect(container.querySelector('[data-testid="pending-text"]')?.textContent).toBe(
      'What is the capital of Australia?',
    );
    expect(container.querySelector('[data-testid="pending-spoken"]')?.textContent).toBe(
      'Spoken · 0:03',
    );
    // Rien n'est encore écrit : l'agent réfléchit, et Stop peut l'arrêter.
    expect(
      container.querySelector('[data-testid="composer-stop"]')?.getAttribute('aria-label'),
    ).toBe('Stop the answer');

    await act(async () => {
      held.write('delta', { text: 'Canberra. ' });
      held.write('audio', VOICE);
    });
    await settle();
    expect(container.querySelector('[data-testid="pending-reply"]')?.textContent).toBe('Canberra.');
    // La voix joue avant la fin du flux, et « Speaking » est sur la réponse qui s'écrit.
    expect(audio.scheduled).toHaveLength(1);
    expect(container.querySelector('[data-testid="pending-thinking"]')?.textContent).toContain(
      'Speaking',
    );
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      held.write('delta', { text: 'Not Sydney.' });
      held.write('audio', { ...VOICE, seq: 1, base64: pcmBase64([4, 5]) });
      held.write('done', { reply: 'Canberra. Not Sydney.', ...DONE });
      held.close();
    });
    await settle();
    // Bout à bout, dans l'ordre.
    expect(audio.scheduled.map((s) => s.samples.length)).toEqual([3, 2]);
    expect(audio.scheduled[1]!.at).toBeCloseTo(audio.scheduled[0]!.at + 3 / 24_000, 9);
    expect(refresh).toHaveBeenCalled();
  });

  it('Stop mid-stream: the voice falls silent, the runner is asked to stop the turn, and the stream is abandoned', async () => {
    const held = heldStream();
    endReply = async () => held.response;
    await renderThread();
    await hold();
    await releaseAt();
    await act(async () => {
      held.write('transcript', { transcript: 'Tell me a story', durationMs: 1200 });
      held.write('delta', { text: 'Once upon a time. ' });
      held.write('audio', VOICE);
    });
    await settle();
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-stop-speaking"]',
    );
    expect(stop?.getAttribute('aria-label')).toBe('Stop speaking');

    await act(async () => {
      stop?.click();
    });
    await settle();
    expect(audio.scheduled[0]?.stopped).toBe(true);
    expect(sent.filter((r) => r.url === '/api/chat/stop')).toEqual([
      { method: 'POST', url: '/api/chat/stop', body: { conversationId: 'conv-1' } },
    ]);
    expect(endSignal?.aborted).toBe(true);
    // Ce qui arriverait encore ne joue pas.
    await act(async () => {
      try {
        held.write('audio', { ...VOICE, seq: 1 });
      } catch {
        // le flux est déjà abandonné
      }
    });
    await settle();
    expect(audio.scheduled).toHaveLength(1);
    expect(container.querySelector('[data-testid="composer-send"]')?.textContent).toBe('Send');
    expect(refresh).toHaveBeenCalled();
  });

  it('a compressed voice (MP3) plays when the route says its sentence is complete (`audio_end`)', async () => {
    const held = heldStream();
    endReply = async () => held.response;
    await renderThread();
    await hold();
    await releaseAt();
    const frame = Buffer.from([0x49, 0x44, 0x33, 2, 128, 64]).toString('base64');
    await act(async () => {
      held.write('transcript', { transcript: 'Hi', durationMs: 900 });
      held.write('delta', { text: 'Hello. ' });
      held.write('audio', { seq: 0, mimeType: 'audio/mpeg', base64: frame });
    });
    await settle();
    expect(audio.scheduled).toEqual([]);
    await act(async () => {
      held.write('audio_end', { sentence: 0 });
    });
    await settle();
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, 0.25]]);
    expect(noteText()).toBeNull();
  });

  it('a new gesture during the reply silences it: nothing of the old reply plays over the new one', async () => {
    const held = heldStream();
    endReply = async () => held.response;
    await renderThread();
    await hold();
    await releaseAt();
    await act(async () => {
      held.write('transcript', { transcript: 'Tell me a story', durationMs: 1200 });
    });
    await settle();
    mic.stopped = false;
    await hold();
    await act(async () => {
      held.write('delta', { text: 'Once upon a time. ' });
      held.write('audio', VOICE);
    });
    await settle();
    expect(audio.scheduled).toEqual([]);
  });
});
