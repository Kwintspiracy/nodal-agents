/**
 * settings-voice.spec.ts — choisir la voix avec laquelle Nodal parle (#969), au navigateur.
 *
 * Le propriétaire veut passer d'une voix à l'autre quand il veut, pour les
 * comparer sur de vrais tours. Ce parcours prouve, sur un vrai Chromium :
 *   — Réglages → Workspace montre la section Voice, avec la voix ENREGISTRÉE
 *     (source, modèle, voix) et les choix que la source a listés ;
 *   — passer à Google vide le modèle et la voix (rien n'est choisi à la place
 *     de la personne), puis « Play a sample » fait entendre la voix À L'ÉCRAN,
 *     avant de l'enregistrer : la requête porte cette voix, et l'audio rendu
 *     est joué ;
 *   — Save envoie ce réglage et seulement lui ;
 *   — une source sans clé le dit, avec ce qu'il faut faire.
 *
 * Aucun runner ni fournisseur : les routes de la voix sont interceptées À LA
 * PORTE WEB (`/api/voice/setting`, `/api/voice/sample`), qui les relaie au
 * runner (règle du #948). Ce que le runner fait du réglage est prouvé côté
 * moteur (apps/runner/src/tests/routes/voice-turn.test.ts, describe #969).
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

test.beforeAll(async () => {
  await requireLiveStack();
});

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
const FIRST = {
  source: 'openrouter',
  model: 'google/gemini-3.8-flash-tts',
  voice: 'Kore',
  transcriptionSource: 'openrouter',
  transcriptionModel: 'x-ai/grok-stt-1.0',
};

/** Une seconde de silence en PCM 16 bits mono à 24 kHz : ce que la route rend, en base64. */
const SILENT_PCM = Buffer.alloc(24_000 * 2).toString('base64');

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

type Seen = { method: string; path: string; body: unknown };

/** #1048 — what the runner's trial answers for each part, and what a server lists. */
type Stubs = {
  check?: (body: { part: string; listening?: unknown }) => unknown;
  models?: () => unknown;
};

async function stubVoice(page: Page, sources: unknown[], stubs: Stubs = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  const note = (route: Route) => {
    const req = route.request();
    seen.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body: req.postData() ? (JSON.parse(req.postData()!) as unknown) : null,
    });
  };
  await page.route('**/api/voice/setting', async (route) => {
    note(route);
    if (route.request().method() === 'PUT') {
      // The runner answers the setting as a client reads it: a key is only `hasKey` (#1048).
      const { setting } = route.request().postDataJSON() as {
        setting: Record<string, { address: string; key: unknown } | string>;
      };
      const view = Object.fromEntries(
        Object.entries(setting).map(([k, v]) =>
          typeof v === 'object' && v !== null && 'key' in v
            ? [k, { address: v.address, hasKey: typeof v.key === 'object' }]
            : [k, v],
        ),
      );
      await route.fulfill({ json: { setting: view } });
      return;
    }
    await route.fulfill({ json: { setting: FIRST, sources, transcription: EAR } });
  });
  await page.route('**/api/voice/check', async (route) => {
    note(route);
    const body = route.request().postDataJSON() as { part: string; listening?: unknown };
    await route.fulfill({
      json: stubs.check?.(body) ?? {
        part: body.part,
        state: 'answers',
        model: body.part === 'listening' ? 'x-ai/grok-stt-1.0' : 'google/gemini-3.8-flash-tts',
        latencyMs: 620,
        ...(body.part === 'listening' ? { heard: 'OK.' } : {}),
        checkedAt: new Date().toISOString(),
      },
    });
  });
  await page.route('**/api/voice/server/models', async (route) => {
    note(route);
    await route.fulfill({
      json: stubs.models?.() ?? { state: 'listed', models: [], listedAt: new Date().toISOString() },
    });
  });
  await page.route('**/api/voice/sample', async (route) => {
    note(route);
    const body = [
      `event: audio\ndata: ${JSON.stringify({ seq: 0, sentence: 0, mimeType: 'audio/pcm', sampleRate: 24_000, base64: SILENT_PCM })}\n\n`,
      `event: audio_end\ndata: ${JSON.stringify({ sentence: 0, complete: true })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ speechError: null, source: 'google', model: 'gemini-3.8-flash-tts', voice: 'Puck', transcriptionModel: 'x-ai/grok-stt-1.0' })}\n\n`,
    ].join('');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });
  return seen;
}

test.describe('the Voice setting @cap:parler-a-un-agent/ecran', () => {
  test('shows the stored voice and ear, tries another voice before saving it, and saves exactly that setting', async ({
    page,
  }) => {
    const seen = await stubVoice(page, [OPENROUTER, GOOGLE]);
    await page.goto('/settings?page=workspace');

    const section = page.getByTestId('setting-section-voice');
    await expect(section.getByRole('heading', { name: 'Voice', level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await expect(section.getByTestId('voice-model')).toHaveValue('google/gemini-3.8-flash-tts', {
      timeout: 15_000,
    });
    await expect(section.getByTestId('voice-voice')).toHaveValue('Kore');
    await expect(
      section.getByText('Models and voices listed by OpenRouter, kept for an hour.'),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // Google: nothing is chosen for the person.
    await section.getByTestId('voice-source-google').click();
    await expect(section.getByTestId('voice-model')).toHaveValue('');
    await expect(section.getByTestId('voice-sample')).toBeDisabled();
    await section.getByTestId('voice-model').selectOption('gemini-3.8-flash-tts');
    await section.getByTestId('voice-voice').selectOption('Puck');

    // The sample speaks the voice on screen, before it is saved.
    await section.getByTestId('voice-sample').click();
    await expect(section.getByTestId('voice-sample-stop')).toBeVisible();
    await expect
      .poll(() => seen.filter((s) => s.path === '/api/voice/sample').map((s) => s.body))
      .toEqual([
        {
          text: 'Hello, this is how I sound when I answer you.',
          // The voice only: the sample speaks, it does not listen (#976).
          setting: { source: 'google', model: 'gemini-3.8-flash-tts', voice: 'Puck' },
        },
      ]);
    await section.getByTestId('voice-sample-stop').click();
    await expect(section.getByTestId('voice-sample')).toBeVisible();
    // Trying never saves.
    expect(seen.filter((s) => s.method === 'PUT')).toEqual([]);

    // #976: the ear is chosen in the same section, among OpenRouter's transcription models.
    await expect(section.getByTestId('voice-transcription')).toHaveValue('x-ai/grok-stt-1.0');
    await section.getByTestId('voice-transcription').selectOption('openai/gpt-transcribe');

    await section.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => seen.filter((s) => s.method === 'PUT').map((s) => s.body))
      .toEqual([
        {
          setting: {
            source: 'google',
            model: 'gemini-3.8-flash-tts',
            voice: 'Puck',
            transcriptionSource: 'openrouter',
            transcriptionModel: 'openai/gpt-transcribe',
          },
        },
      ]);
    await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0);
  });

  test('a source without a key says so, and what to do', async ({ page }) => {
    await stubVoice(page, [
      OPENROUTER,
      { source: 'google', state: 'unavailable', code: 'voice_key_missing' },
    ]);
    await page.goto('/settings?page=workspace');
    const section = page.getByTestId('setting-section-voice');
    await expect(section.getByTestId('voice-model')).toBeVisible({ timeout: 30_000 });
    await section.getByTestId('voice-source-google').click();
    await expect(section.getByTestId('voice-source-unavailable')).toHaveText(
      'No Google key in this workspace. Add one in LLM Providers to speak through Google.',
    );
    await expect(section.getByTestId('voice-model')).toHaveCount(0);
  });

  // #1048 — listening on a server the person runs: the address typed, the
  // models it lists, the state under the part, then exactly that saved.
  test('listens on a local server: its models at the address typed, its state, and Save sends it', async ({
    page,
  }) => {
    const whisper = 'openai/whisper-large-v3-turbo';
    const seen = await stubVoice(page, [OPENROUTER, GOOGLE], {
      models: () => ({
        state: 'listed',
        models: [{ id: whisper }],
        listedAt: new Date().toISOString(),
      }),
      check: (body) =>
        body.part === 'listening' && body.listening
          ? {
              part: 'listening',
              state: 'answers',
              model: whisper,
              latencyMs: 210,
              heard: 'OK.',
              checkedAt: new Date().toISOString(),
            }
          : undefined,
    });
    await page.goto('/settings?page=workspace');
    const section = page.getByTestId('setting-section-voice');
    await expect(section.getByTestId('voice-transcription')).toHaveValue('x-ai/grok-stt-1.0', {
      timeout: 30_000,
    });
    // The state is always there, the saved ear's included.
    await expect(section.getByTestId('voice-listening-status')).toContainText(
      'Answers. x-ai/grok-stt-1.0 wrote back the sample “OK.” in 0.62 s.',
    );

    await section.getByTestId('voice-ear-source-openai-compatible').click();
    await expect(section.getByTestId('voice-transcription-hint')).toContainText(
      'Nodal does not start or stop it.',
    );
    await section.getByTestId('voice-transcription-address').fill('http://127.0.0.1:8786/v1');
    await expect(section.getByTestId('voice-transcription-listed')).toHaveText(
      'Models listed by the server at 127.0.0.1:8786, read just now.',
    );
    await section.getByTestId('voice-transcription').selectOption(whisper);
    await expect(section.getByTestId('voice-listening-status')).toContainText(
      `Answers. ${whisper} wrote back the sample “OK.” in 0.21 s.`,
    );
    await expect(section.getByTestId('voice-unsaved')).toHaveText(
      'Unsaved change: listening moves from OpenRouter to the local server.',
    );
    await section.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => seen.filter((s) => s.method === 'PUT').map((s) => s.body))
      .toEqual([
        {
          setting: {
            ...FIRST,
            transcriptionSource: 'openai-compatible',
            transcriptionModel: whisper,
            transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: 'none' },
          },
        },
      ]);
  });
});
