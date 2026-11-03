// VoiceSection.test.tsx — Réglages → Voice (#969), état par état.
//
// Les routes sont le `fetch` du navigateur, enregistré ; la voix joue sur
// l'AudioContext factice du chat (`fake-audio.ts`), qui note ce qui aurait été
// entendu. Les assertions portent sur ce qui est ARRIVÉ : le corps de chaque
// requête, les phrases à l'écran, les échantillons programmés — jamais un
// nombre d'appels (invariant #5). Les phrases sont écrites EN DUR : un test qui
// lirait la constante du composant resterait vert quand on la change.
//
// Les états : OpenRouter choisi, Google choisi, Google sans clé, un essai qui
// joue, une erreur (refus d'enregistrer, essai sans crédit, runner muet).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installFakeAudio, pcmBase64, sseBody } from '../../chat/__tests__/fake-audio.ts';
import { stopSpeaking } from '../../chat/voice-playback.ts';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom ne fournit pas `CSS.supports`, que le `Select` du design system lit
// (comme ApprovalRequestCard.test.tsx) : le sélecteur natif, sans `base-select`.
if (typeof globalThis.CSS?.supports !== 'function') {
  globalThis.CSS = { supports: () => false } as unknown as typeof globalThis.CSS;
}

const { default: VoiceSection } = await import('../VoiceSection.tsx');

const OPENROUTER = {
  source: 'openrouter',
  state: 'available',
  models: [
    {
      id: 'google/gemini-3.8-flash-tts',
      label: 'Google: Gemini 3.8 Flash TTS',
      voices: [
        { id: 'Kore', label: 'Kore' },
        { id: 'Puck', label: 'Puck' },
      ],
    },
    {
      id: 'x-ai/grok-voice-tts-1.0',
      label: 'SpaceXAI: Grok Voice TTS 1.0',
      voices: [
        { id: 'eve', label: 'eve' },
        { id: 'leo', label: 'leo' },
      ],
    },
    {
      id: 'google/gemini-3.8-flash-lite-tts',
      label: 'Google: Gemini 3.8 Flash Lite TTS',
      voices: [
        { id: 'Kore', label: 'Kore' },
        { id: 'Puck', label: 'Puck' },
      ],
    },
    { id: 'fish-audio/s1', label: 'Fish Audio: S1', voices: [] },
  ],
  listedAt: '2026-11-03T10:00:00.000Z',
  cacheSeconds: 3600,
};
const GOOGLE = {
  source: 'google',
  state: 'available',
  models: [
    {
      id: 'gemini-3.8-flash-tts',
      label: 'Gemini 3.8 Flash TTS',
      voices: [
        { id: 'Kore', label: 'Kore', description: 'Firm' },
        { id: 'Puck', label: 'Puck', description: 'Upbeat' },
      ],
    },
  ],
  listedAt: '2026-11-03T10:00:00.000Z',
  cacheSeconds: 3600,
};
const GOOGLE_NO_KEY = { source: 'google', state: 'unavailable', code: 'voice_key_missing' };
const FIRST = { source: 'openrouter', model: 'google/gemini-3.8-flash-tts', voice: 'Kore' };

type Seen = { method: string; url: string; body: unknown };

let seen: Seen[];
let answers: {
  state: () => Response;
  put: (body: unknown) => Response;
  sample: (body: unknown) => Response;
};
let audio: ReturnType<typeof installFakeAudio>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seen = [];
  audio = installFakeAudio(vi.stubGlobal);
  answers = {
    state: () => Response.json({ setting: FIRST, sources: [OPENROUTER, GOOGLE] }),
    put: (body) => Response.json(body),
    sample: () =>
      new Response(
        sseBody([
          [
            'audio',
            {
              seq: 0,
              sentence: 0,
              mimeType: 'audio/pcm',
              sampleRate: 24_000,
              base64: pcmBase64([1000, -1000]),
            },
          ],
          ['audio_end', { sentence: 0, complete: true }],
          ['done', { speechError: null, source: 'openrouter', model: 'x', voice: 'y' }],
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ method, url, body });
      if (url === '/api/voice/setting' && method === 'GET') return answers.state();
      if (url === '/api/voice/setting' && method === 'PUT') return answers.put(body);
      if (url === '/api/voice/sample') return answers.sample(body);
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopSpeaking();
  vi.unstubAllGlobals();
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<VoiceSection />);
  });
  // The read resolves after the first paint.
  await act(async () => {});
}

const q = <T extends Element = HTMLElement>(testId: string): T | null =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

async function choose(testId: string, value: string) {
  const el = q<HTMLSelectElement>(testId)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el: Element | null) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => {});
}

function optionTexts(testId: string): string[] {
  return [...q<HTMLSelectElement>(testId)!.options].map((o) =>
    o.disabled ? `${o.text} [off]` : o.text,
  );
}

describe('the Voice section @cap:parler-a-un-agent/ecran', () => {
  it('OpenRouter chosen: shows the stored voice, the models and voices the source lists, and how long the list is kept', async () => {
    await render();
    expect(seen[0]).toEqual({ method: 'GET', url: '/api/voice/setting', body: null });
    expect(q('voice-source-openrouter')!.getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLSelectElement>('voice-model')!.value).toBe('google/gemini-3.8-flash-tts');
    expect(q<HTMLSelectElement>('voice-voice')!.value).toBe('Kore');
    expect(optionTexts('voice-model')).toEqual([
      'Choose a model',
      'Google: Gemini 3.8 Flash TTS',
      'SpaceXAI: Grok Voice TTS 1.0',
      'Google: Gemini 3.8 Flash Lite TTS',
      'Fish Audio: S1 (no voices listed) [off]',
    ]);
    expect(q('voice-listed')!.textContent).toBe(
      'Models and voices listed by OpenRouter, kept for an hour.',
    );
    // Nothing changed: nothing to save.
    expect(container.textContent).not.toContain('Save');
  });

  // Mutation verified: `pickModel` resetting the voice even when the new model
  // offers it → red.
  it('choosing a model and a voice, then Save, sends that setting, and nothing else', async () => {
    await render();
    // The lite model offers Kore too: the voice stays.
    await choose('voice-model', 'google/gemini-3.8-flash-lite-tts');
    expect(q<HTMLSelectElement>('voice-voice')!.value).toBe('Kore');
    await choose('voice-model', 'x-ai/grok-voice-tts-1.0');
    // Kore is not a Grok voice: the voice is to choose again, never kept.
    expect(q<HTMLSelectElement>('voice-voice')!.value).toBe('');
    expect(optionTexts('voice-voice')).toEqual(['Choose a voice', 'eve', 'leo']);
    await choose('voice-voice', 'leo');
    const form = q<HTMLFormElement>('voice-section')!;
    await act(async () => {
      form.requestSubmit();
    });
    await act(async () => {});
    expect(seen.filter((s) => s.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        url: '/api/voice/setting',
        body: { setting: { source: 'openrouter', model: 'x-ai/grok-voice-tts-1.0', voice: 'leo' } },
      },
    ]);
    expect(container.textContent).not.toContain('Save');
  });

  it('Google chosen: the model and the voice are to choose, its prebuilt voices with their description', async () => {
    await render();
    await click(q('voice-source-google'));
    expect(q<HTMLSelectElement>('voice-model')!.value).toBe('');
    expect(optionTexts('voice-model')).toEqual(['Choose a model', 'Gemini 3.8 Flash TTS']);
    expect(q<HTMLButtonElement>('voice-sample')!.disabled).toBe(true);
    await choose('voice-model', 'gemini-3.8-flash-tts');
    expect(optionTexts('voice-voice')).toEqual(['Choose a voice', 'Kore, Firm', 'Puck, Upbeat']);
    expect(q('voice-listed')!.textContent).toBe(
      'Models and voices listed by Google, kept for an hour.',
    );
  });

  it('Google without a key: says so and what to do, offers no model', async () => {
    answers.state = () => Response.json({ setting: FIRST, sources: [OPENROUTER, GOOGLE_NO_KEY] });
    await render();
    await click(q('voice-source-google'));
    expect(q('voice-source-unavailable')!.textContent).toBe(
      'No Google key in this workspace. Add one in LLM Providers to speak through Google.',
    );
    expect(q('voice-model')).toBeNull();
    expect(q<HTMLButtonElement>('voice-sample')!.disabled).toBe(true);
  });

  // Mutation verified: the sample sent without the voice on screen (no
  // `setting` when dirty) → red.
  it('a sample plays the voice on screen, back to back, and Stop silences it', async () => {
    await render();
    await choose('voice-model', 'x-ai/grok-voice-tts-1.0');
    await choose('voice-voice', 'eve');
    await click(q('voice-sample'));
    expect(seen.filter((s) => s.url === '/api/voice/sample')).toEqual([
      {
        method: 'POST',
        url: '/api/voice/sample',
        body: {
          text: 'Hello, this is how I sound when I answer you.',
          setting: { source: 'openrouter', model: 'x-ai/grok-voice-tts-1.0', voice: 'eve' },
        },
      },
    ]);
    await act(async () => {});
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.031, -0.031]]);
    // Still audible: Stop is there, and silences it.
    expect(q('voice-sample-stop')).not.toBeNull();
    await click(q('voice-sample-stop'));
    expect(audio.scheduled[0]!.stopped).toBe(true);
    expect(q('voice-sample')).not.toBeNull();
  });

  it('the stored voice is sampled without a setting: the runner reads its own', async () => {
    await render();
    await click(q('voice-sample'));
    expect(seen.find((s) => s.url === '/api/voice/sample')!.body).toEqual({
      text: 'Hello, this is how I sound when I answer you.',
    });
  });

  // A voice that answers mp3 (MiniMax) plays through the SAME player as a
  // turn's voice (#968): its chunks are joined per sentence and decoded at a
  // complete `audio_end`. Mutation verified: `endSentence` not called by the
  // sample → red (nothing plays).
  it('a sample in mp3 plays through the turn player: joined per sentence, decoded once complete', async () => {
    // The fake MP3 frame `fake-audio.ts` decodes: `ID3`, a length, the bytes.
    const frame = Buffer.from([0x49, 0x44, 0x33, 4, 128, 64, 32, 16]);
    answers.sample = () =>
      new Response(
        sseBody([
          [
            'audio',
            {
              seq: 0,
              sentence: 0,
              mimeType: 'audio/mpeg',
              base64: frame.subarray(0, 5).toString('base64'),
            },
          ],
          [
            'audio',
            {
              seq: 1,
              sentence: 0,
              mimeType: 'audio/mpeg',
              base64: frame.subarray(5).toString('base64'),
            },
          ],
          ['audio_end', { sentence: 0, complete: true }],
          [
            'done',
            {
              speechError: null,
              source: 'openrouter',
              model: 'minimax/speech-2.8-turbo',
              voice: 'English_CalmWoman',
            },
          ],
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    await render();
    await click(q('voice-sample'));
    await act(async () => {});
    expect(audio.scheduled.map((s) => s.samples)).toEqual([[0.5, 0.25, 0.125, 0.063]]);
    expect(q('voice-sample-error')).toBeNull();
  });

  it('errors are said: a refused save, a sample without credit, a runner that does not answer', async () => {
    answers.put = () =>
      Response.json(
        {
          error: 'voice_not_offered',
          source: 'openrouter',
          detail: 'x-ai/grok-voice-tts-1.0 offers eve, leo',
        },
        { status: 409 },
      );
    answers.sample = () =>
      new Response(
        sseBody([
          [
            'done',
            {
              speechError: {
                code: 'speech_no_credit',
                detail:
                  'google gemini-3.8-flash-tts: HTTP 402 — Your prepayment credits are depleted.',
              },
              source: 'google',
              model: 'gemini-3.8-flash-tts',
              voice: 'Kore',
            },
          ],
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    await render();
    await choose('voice-model', 'x-ai/grok-voice-tts-1.0');
    await choose('voice-voice', 'leo');
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(q('voice-save-error')!.textContent).toBe(
      'This model does not offer that voice (x-ai/grok-voice-tts-1.0 offers eve, leo).',
    );

    await click(q('voice-sample'));
    expect(q('voice-sample-error')!.textContent).toBe(
      'The Google key has no credit left.google gemini-3.8-flash-tts: HTTP 402 — Your prepayment credits are depleted.',
    );
    expect(audio.scheduled).toEqual([]);

    act(() => root.unmount());
    container.remove();
    answers.state = () => {
      throw new TypeError('fetch failed');
    };
    await render();
    expect(q('voice-load-error')!.textContent).toBe(
      'The runner did not answer. Reload the page, and check the runner is up.',
    );
  });

  it('a stored voice that cannot be read is said, and a voice can be chosen', async () => {
    answers.state = () =>
      Response.json({
        setting: null,
        settingProblem: { code: 'voice_setting_unreadable' },
        sources: [OPENROUTER, GOOGLE],
      });
    await render();
    expect(q('voice-setting-problem')!.textContent).toBe(
      'The stored voice could not be read. Choose one.',
    );
    await click(q('voice-source-openrouter'));
    expect(optionTexts('voice-model')[0]).toBe('Choose a model');
  });
});
