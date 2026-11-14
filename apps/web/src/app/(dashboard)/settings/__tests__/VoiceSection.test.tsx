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
const FIRST = {
  source: 'openrouter',
  model: 'google/gemini-3.8-flash-tts',
  voice: 'Kore',
  transcriptionSource: 'openrouter',
  transcriptionModel: 'x-ai/grok-stt-1.0',
};

/** The models of OpenRouter's transcription endpoint (#976). */
const EAR = {
  state: 'available',
  models: [
    { id: 'x-ai/grok-stt-1.0', label: 'SpaceXAI: Grok STT 1.0' },
    { id: 'openai/gpt-transcribe', label: 'OpenAI: GPT Transcribe' },
  ],
  listedAt: '2026-11-03T10:00:00.000Z',
  cacheSeconds: 3600,
};
const EAR_NO_KEY = { state: 'unavailable', code: 'voice_key_missing' };

type Seen = { method: string; url: string; body: unknown };

let seen: Seen[];
let answers: {
  state: () => Response;
  put: (body: unknown) => Response;
  sample: (body: unknown) => Response;
  /** #1048 — the state of a part, and the models of a server. */
  check: (body: unknown) => Response;
  models: (body: unknown) => Response;
};
let audio: ReturnType<typeof installFakeAudio>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seen = [];
  audio = installFakeAudio(vi.stubGlobal);
  answers = {
    state: () =>
      Response.json({ setting: FIRST, sources: [OPENROUTER, GOOGLE], transcription: EAR }),
    put: (body) => Response.json(body),
    check: (body) => {
      const part = (body as { part: string }).part;
      return Response.json({
        part,
        state: 'answers',
        model: part === 'listening' ? 'x-ai/grok-stt-1.0' : 'google/gemini-3.8-flash-tts',
        latencyMs: 620,
        ...(part === 'listening' ? { heard: 'OK.' } : {}),
        checkedAt: '2026-11-11T10:42:00.000Z',
      });
    },
    models: () =>
      Response.json({ state: 'listed', models: [], listedAt: '2026-11-11T10:42:00.000Z' }),
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
          [
            'done',
            {
              speechError: null,
              source: 'openrouter',
              model: 'x',
              voice: 'y',
              transcriptionModel: 'x-ai/grok-stt-1.0',
            },
          ],
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
      if (url === '/api/voice/check') return answers.check(body);
      if (url === '/api/voice/server/models') return answers.models(body);
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
        body: {
          setting: {
            source: 'openrouter',
            model: 'x-ai/grok-voice-tts-1.0',
            voice: 'leo',
            transcriptionSource: 'openrouter',
            transcriptionModel: 'x-ai/grok-stt-1.0',
          },
        },
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
    answers.state = () =>
      Response.json({ setting: FIRST, sources: [OPENROUTER, GOOGLE_NO_KEY], transcription: EAR });
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
          // The voice only: the sample speaks, it does not listen (#976).
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
              transcriptionModel: 'x-ai/grok-stt-1.0',
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
              transcriptionModel: 'x-ai/grok-stt-1.0',
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

  // Review of #972, pass 1: Save tries the voice first; one that does not speak
  // is refused with the vendor's words, said at Save. Mutation verified: the
  // detail dropped from `refusalText` → red.
  it('a voice that did not speak when tried is refused at Save, with the vendor words', async () => {
    answers.put = () =>
      Response.json(
        {
          error: 'speech_provider_error',
          source: 'openrouter',
          detail:
            'openrouter minimax/speech-2.8-turbo: HTTP 400 — MiniMax TTS only supports response_format="mp3" for streaming. Got "pcm".',
        },
        { status: 409 },
      );
    await render();
    await choose('voice-model', 'x-ai/grok-voice-tts-1.0');
    await choose('voice-voice', 'leo');
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(q('voice-save-error')!.textContent).toBe(
      'This voice did not speak, so it was not saved: openrouter minimax/speech-2.8-turbo: HTTP 400 — MiniMax TTS only supports response_format="mp3" for streaming. Got "pcm".',
    );
    // The form stays dirty: nothing was saved.
    expect(container.textContent).toContain('Save');
  });

  it('a stored voice that cannot be read is said, and a voice can be chosen', async () => {
    answers.state = () =>
      Response.json({
        setting: null,
        settingProblem: { code: 'voice_setting_unreadable' },
        sources: [OPENROUTER, GOOGLE],
        transcription: EAR,
      });
    await render();
    expect(q('voice-setting-problem')!.textContent).toBe(
      'The stored voice could not be read. Choose one.',
    );
    await click(q('voice-source-openrouter'));
    expect(optionTexts('voice-model')[0]).toBe('Choose a model');
  });
});

describe('the Voice section — the transcription model (#976) @cap:parler-a-un-agent/ecran', () => {
  it('shows the stored model among those OpenRouter lists for transcription, and how long the list is kept', async () => {
    await render();
    expect(q<HTMLSelectElement>('voice-transcription')!.value).toBe('x-ai/grok-stt-1.0');
    expect(optionTexts('voice-transcription')).toEqual([
      'Choose a model',
      'SpaceXAI: Grok STT 1.0',
      'OpenAI: GPT Transcribe',
    ]);
    expect(q('voice-transcription-listed')!.textContent).toBe(
      'Transcription models listed by OpenRouter, kept for an hour.',
    );
  });

  // Mutation verified: `pickEar` not wired (the select changes nothing) → red.
  it('choosing another transcription model, then Save, sends it with the voice unchanged', async () => {
    await render();
    await choose('voice-transcription', 'openai/gpt-transcribe');
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(seen.filter((s) => s.method === 'PUT').map((s) => s.body)).toEqual([
      { setting: { ...FIRST, transcriptionModel: 'openai/gpt-transcribe' } },
    ]);
  });

  it('without an OpenRouter key: says so, offers no model, and the voice stays choosable', async () => {
    answers.state = () =>
      Response.json({ setting: FIRST, sources: [OPENROUTER, GOOGLE], transcription: EAR_NO_KEY });
    await render();
    expect(q('voice-transcription')).toBeNull();
    expect(q('voice-transcription-unavailable')!.textContent).toBe(
      'No OpenRouter key in this workspace. Add one in LLM Providers to transcribe what you say.',
    );
    expect(q<HTMLSelectElement>('voice-model')!.value).toBe('google/gemini-3.8-flash-tts');
  });

  it('a model that did not write down what the voice said is refused at Save, with what it wrote', async () => {
    answers.put = () =>
      Response.json(
        {
          error: 'transcription_not_faithful',
          source: 'openrouter',
          detail: 'deepgram/nova-3 wrote nothing for the voice saying "OK."',
        },
        { status: 409 },
      );
    await render();
    await choose('voice-transcription', 'openai/gpt-transcribe');
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(q('voice-save-error')!.textContent).toBe(
      'This model did not write down what the voice said, so it was not saved: deepgram/nova-3 wrote nothing for the voice saying "OK."',
    );
  });
});

// ─── #1048 — the six states of the approved mockup ──────────────────────────
//
// Each part has its source; "Local server" is a server the person runs, at
// the address they type. The state under each part is the runner's trial
// (`/api/voice/check`); the models of a server are read at its address
// (`/api/voice/server/models`). Typing waits for a pause before the server is
// asked: the tests wait for it, for real.

/** A local time of 2026-11-11, as an ISO string: the screen shows the local clock. */
const at = (h: number, m: number): string => new Date(2026, 10, 11, h, m).toISOString();

async function pause(ms = 500) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await act(async () => {});
}

async function type(testId: string, value: string) {
  const el = q<HTMLInputElement>(testId)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = (testId: string): string | null => q(testId)?.textContent ?? null;
const checksSent = () => seen.filter((x) => x.url === '/api/voice/check').map((x) => x.body);
const modelsAsked = () =>
  seen.filter((x) => x.url === '/api/voice/server/models').map((x) => x.body);

const WHISPER = 'openai/whisper-large-v3-turbo';
const GOOGLE_SAVED = {
  source: 'google',
  model: 'gemini-3.8-flash-tts',
  voice: 'Kore',
  transcriptionSource: 'openrouter',
  transcriptionModel: 'x-ai/grok-stt-1.0',
};

describe('the Voice section — each part has its source, and a server the person runs (#1048) @cap:parler-a-un-agent/ecran', () => {
  // State 1 of the mockup.
  it('1 · each part shows its source and, always, whether it answers', async () => {
    answers.state = () =>
      Response.json({ setting: GOOGLE_SAVED, sources: [OPENROUTER, GOOGLE], transcription: EAR });
    answers.check = (body) => {
      const part = (body as { part: string }).part;
      return Response.json(
        part === 'listening'
          ? {
              part,
              state: 'answers',
              model: 'x-ai/grok-stt-1.0',
              latencyMs: 620,
              heard: 'OK.',
              checkedAt: at(10, 42),
            }
          : {
              part,
              state: 'answers',
              model: 'gemini-3.8-flash-tts',
              latencyMs: 900,
              checkedAt: at(10, 42),
            },
      );
    };
    await render();
    await pause(50);
    expect(q('voice-source-google')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('voice-ear-source-openrouter')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('voice-ear-source-openai-compatible')!.textContent).toBe('Local server');
    expect(q('voice-source-openai-compatible')!.textContent).toBe('Local server');
    // The saved parts are checked as they are stored: the request names only the part.
    expect(checksSent()).toEqual([{ part: 'speaking' }, { part: 'listening' }]);
    expect(text('voice-listening-status')).toBe(
      'Answers. x-ai/grok-stt-1.0 wrote back the sample “OK.” in 0.62 s. Checked at 10:42.Check again',
    );
    expect(text('voice-speaking-status')).toBe(
      'Answers. gemini-3.8-flash-tts spoke the sample. Checked at 10:42.Check again',
    );
    // Check again tries for real (`fresh`).
    await click(q('voice-listening-check-again'));
    expect(checksSent().at(-1)).toEqual({ part: 'listening', fresh: true });
  });

  // State 2. Mutation verified: the listening part of the check request
  // dropped (the stored ear checked instead of the one on screen) → red.
  it('2 · listening on a local server that answers: its models, the trial on the address typed, and Save sends it', async () => {
    answers.state = () =>
      Response.json({ setting: GOOGLE_SAVED, sources: [OPENROUTER, GOOGLE], transcription: EAR });
    answers.models = () =>
      Response.json({ state: 'listed', models: [{ id: WHISPER }], listedAt: at(10, 43) });
    answers.check = (body) => {
      const b = body as { part: string; listening?: unknown };
      return Response.json(
        b.part === 'listening' && b.listening
          ? {
              part: 'listening',
              state: 'answers',
              model: WHISPER,
              latencyMs: 210,
              heard: 'OK.',
              checkedAt: at(10, 43),
            }
          : { part: b.part, state: 'answers', model: 'm', latencyMs: 1, checkedAt: at(10, 40) },
      );
    };
    await render();
    await click(q('voice-ear-source-openai-compatible'));
    expect(text('voice-transcription-hint')).toBe(
      'A transcription server you run yourself, on this computer or your network. Nodal sends it the audio at the standard address, /audio/transcriptions. Nodal does not start or stop it.',
    );
    expect(q<HTMLInputElement>('voice-transcription-key')!.placeholder).toBe(
      'Only if your server asks for one',
    );
    await type('voice-transcription-address', 'http://127.0.0.1:8786/v1/');
    await pause();
    expect(modelsAsked()).toEqual([
      { part: 'listening', server: { address: 'http://127.0.0.1:8786/v1', key: 'none' } },
    ]);
    expect(optionTexts('voice-transcription')).toEqual(['Choose a model', WHISPER]);
    expect(text('voice-transcription-listed')).toBe(
      'Models listed by the server at 127.0.0.1:8786, read just now.',
    );
    expect(text('voice-listening-status')).toBe(
      'Not checked yet. Choose a model to try the sample “OK.” on it.',
    );
    await choose('voice-transcription', WHISPER);
    await pause();
    expect(checksSent().at(-1)).toEqual({
      part: 'listening',
      listening: {
        transcriptionSource: 'openai-compatible',
        transcriptionModel: WHISPER,
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: 'none' },
      },
    });
    expect(text('voice-listening-status')).toBe(
      `Answers. ${WHISPER} wrote back the sample “OK.” in 0.21 s. Checked at 10:43.Check again`,
    );
    expect(text('voice-unsaved')).toBe(
      'Unsaved change: listening moves from OpenRouter to the local server.',
    );
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(seen.filter((x) => x.method === 'PUT').map((x) => x.body)).toEqual([
      {
        setting: {
          source: 'google',
          model: 'gemini-3.8-flash-tts',
          voice: 'Kore',
          transcriptionSource: 'openai-compatible',
          transcriptionModel: WHISPER,
          transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: 'none' },
        },
      },
    ]);
  });

  // State 3.
  it('3 · the local server does not answer: the saved model, the reason with its address, and that Nodal will not switch', async () => {
    answers.state = () =>
      Response.json({
        setting: {
          ...GOOGLE_SAVED,
          transcriptionSource: 'openai-compatible',
          transcriptionModel: WHISPER,
          transcriptionServer: { address: 'http://127.0.0.1:8786/v1', hasKey: false },
        },
        sources: [OPENROUTER, GOOGLE],
        transcription: EAR,
      });
    answers.models = () =>
      Response.json({
        state: 'unavailable',
        code: 'speech_unreachable',
        detail: 'http://127.0.0.1:8786/v1/models: list models: no answer (ECONNREFUSED)',
      });
    answers.check = (body) => {
      const part = (body as { part: string }).part;
      return Response.json(
        part === 'listening'
          ? {
              part,
              state: 'not_answering',
              code: 'speech_unreachable',
              detail: 'http://127.0.0.1:8786/v1/models: list models: no answer (ECONNREFUSED)',
              model: WHISPER,
              checkedAt: at(10, 51),
            }
          : {
              part,
              state: 'answers',
              model: 'gemini-3.8-flash-tts',
              latencyMs: 1,
              checkedAt: at(10, 51),
            },
      );
    };
    await render();
    await pause();
    expect(q<HTMLSelectElement>('voice-transcription')!.value).toBe(WHISPER);
    expect(text('voice-transcription-listed')).toBe(
      'The saved model. The server could not list its models: it does not answer.',
    );
    expect(text('voice-listening-status')).toBe(
      'Not answering. Nothing listens at 127.0.0.1:8786 (connection refused). Checked at 10:51.' +
        'Start your transcription server, then check again. Until it answers, what you say to Nodal gets this same error back. Nodal does not switch to OpenRouter on its own.' +
        'Check again',
    );
    expect(q('voice-listening-status')!.getAttribute('role')).toBe('alert');
  });

  // State 4.
  it('4 · a server that lists no models: the name is typed, and nothing is tried before it is', async () => {
    answers.state = () =>
      Response.json({ setting: GOOGLE_SAVED, sources: [OPENROUTER, GOOGLE], transcription: EAR });
    answers.models = () => Response.json({ state: 'listed', models: [], listedAt: at(11, 0) });
    await render();
    await click(q('voice-ear-source-openai-compatible'));
    await type('voice-transcription-address', 'http://192.168.1.20:9000/v1');
    await pause();
    expect(q('voice-transcription')).toBeNull();
    expect(q<HTMLInputElement>('voice-transcription-typed')!.placeholder).toBe(
      'The model name your server expects',
    );
    expect(text('voice-transcription-listed')).toBe(
      'The server at 192.168.1.20:9000 answers, but lists no models at /models. Type the name it expects; Nodal checks it on the sample when you save.',
    );
    expect(text('voice-listening-status')).toBe(
      'Not checked yet. Choose a model to try the sample “OK.” on it.',
    );
    expect(checksSent().filter((b) => (b as { listening?: unknown }).listening)).toEqual([]);
    expect(text('voice-unsaved')).toBe(
      'Unsaved change: listening moves from OpenRouter to the server at 192.168.1.20:9000.',
    );
    await type('voice-transcription-typed', 'my-whisper');
    await pause();
    expect(checksSent().at(-1)).toMatchObject({
      part: 'listening',
      listening: { transcriptionModel: 'my-whisper' },
    });
  });

  // State 5. Mutation verified: `heard` not read from the refusal → red.
  it('5 · Save refused: the sample came back as other words, quoted, and nothing changed', async () => {
    answers.state = () =>
      Response.json({ setting: GOOGLE_SAVED, sources: [OPENROUTER, GOOGLE], transcription: EAR });
    answers.models = () =>
      Response.json({
        state: 'listed',
        models: [{ id: WHISPER }, { id: 'openai/whisper-tiny' }],
        listedAt: at(10, 44),
      });
    answers.put = () =>
      Response.json(
        {
          error: 'transcription_not_faithful',
          source: 'openai-compatible',
          detail: 'openai/whisper-tiny wrote "Thank you." for the voice saying "OK."',
          heard: 'Thank you.',
        },
        { status: 409 },
      );
    await render();
    await click(q('voice-ear-source-openai-compatible'));
    await type('voice-transcription-address', 'http://127.0.0.1:8786/v1');
    await pause();
    await choose('voice-transcription', 'openai/whisper-tiny');
    await act(async () => {
      q<HTMLFormElement>('voice-section')!.requestSubmit();
    });
    await act(async () => {});
    expect(text('voice-save-error')).toBe(
      'Not saved. The sample “OK.”, spoken by your voice, came back from openai/whisper-tiny as “Thank you.”',
    );
    expect(text('voice-save-error-help')).toBe(
      'A model that does not write back a known sample would get what you say wrong too. Choose another model, then save again. Nothing changed: listening stays on OpenRouter.',
    );
    // Still unsaved: the form stays.
    expect(container.textContent).toContain('Save');
  });

  // State 6. Mutation verified: the sample sent without the server (the
  // `speechServer` of the input dropped) → red.
  it('6 · speaking on a local server: its models, a typed voice, a sample through it, and its state', async () => {
    answers.state = () =>
      Response.json({ setting: GOOGLE_SAVED, sources: [OPENROUTER, GOOGLE], transcription: EAR });
    answers.models = () =>
      Response.json({
        state: 'listed',
        models: [{ id: 'qwen3-tts-12hz-1.7b-customvoice' }],
        listedAt: at(10, 58),
      });
    answers.check = (body) => {
      const b = body as { part: string };
      return Response.json(
        b.part === 'speaking'
          ? {
              part: 'speaking',
              state: 'answers',
              model: 'qwen3-tts-12hz-1.7b-customvoice',
              latencyMs: 300,
              checkedAt: at(10, 58),
            }
          : {
              part: 'listening',
              state: 'answers',
              model: 'x-ai/grok-stt-1.0',
              latencyMs: 210,
              heard: 'OK.',
              checkedAt: at(10, 58),
            },
      );
    };
    await render();
    await click(q('voice-source-openai-compatible'));
    expect(text('voice-speech-hint')).toBe(
      'A speech server you run yourself. Nodal sends it the reply at the standard address, /audio/speech. Nodal does not start or stop it.',
    );
    await type('voice-speech-address', 'http://127.0.0.1:8880/v1');
    await type('voice-speech-key', 'sk-voice');
    await pause();
    expect(modelsAsked().at(-1)).toEqual({
      part: 'speaking',
      server: { address: 'http://127.0.0.1:8880/v1', key: { value: 'sk-voice' } },
    });
    expect(text('voice-listed')).toBe(
      "Models listed by the server at 127.0.0.1:8880. Servers do not list their voices in a standard way: type the name your server's documentation gives.",
    );
    await choose('voice-model', 'qwen3-tts-12hz-1.7b-customvoice');
    await type('voice-voice-typed', 'Vivian');
    await pause();
    expect(text('voice-speaking-status')).toBe(
      'Answers. qwen3-tts-12hz-1.7b-customvoice spoke the sample. Checked at 10:58.Check again',
    );
    await click(q('voice-sample'));
    expect(seen.find((x) => x.url === '/api/voice/sample')!.body).toEqual({
      text: 'Hello, this is how I sound when I answer you.',
      setting: {
        source: 'openai-compatible',
        model: 'qwen3-tts-12hz-1.7b-customvoice',
        voice: 'Vivian',
        speechServer: { address: 'http://127.0.0.1:8880/v1', key: { value: 'sk-voice' } },
      },
    });
    // The ear's trial is said by the voice on screen, now that it is complete.
    expect(
      checksSent().some(
        (b) =>
          (b as { part: string }).part === 'listening' &&
          (b as { speaking?: { source: string } }).speaking?.source === 'openai-compatible',
      ),
    ).toBe(true);
  });

  it('a saved key is never shown: the field says one is kept, and an untouched field keeps it at the same address only', async () => {
    answers.state = () =>
      Response.json({
        setting: {
          ...GOOGLE_SAVED,
          transcriptionSource: 'openai-compatible',
          transcriptionModel: WHISPER,
          transcriptionServer: { address: 'http://127.0.0.1:8786/v1', hasKey: true },
        },
        sources: [OPENROUTER, GOOGLE],
        transcription: EAR,
      });
    answers.models = () =>
      Response.json({ state: 'listed', models: [{ id: WHISPER }], listedAt: at(10, 0) });
    await render();
    await pause();
    const key = q<HTMLInputElement>('voice-transcription-key')!;
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('A key is saved. Type a new one to replace it');
    expect(modelsAsked()[0]).toEqual({
      part: 'listening',
      server: { address: 'http://127.0.0.1:8786/v1', key: 'keep' },
    });
    await type('voice-transcription-address', 'http://127.0.0.1:9999/v1');
    await pause();
    expect(modelsAsked().at(-1)).toEqual({
      part: 'listening',
      server: { address: 'http://127.0.0.1:9999/v1', key: 'none' },
    });
    expect(q<HTMLInputElement>('voice-transcription-key')!.placeholder).toBe(
      'Only if your server asks for one',
    );
  });
});
