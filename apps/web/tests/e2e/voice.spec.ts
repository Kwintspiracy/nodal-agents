import { test, expect } from '@playwright/test';
import { requireLiveStack } from './helpers.ts';

/**
 * Voice, phase 1 — the chain a user actually walks.
 *
 * Deliberately NOT seeded: the voice is chosen through the agent form and read
 * back through the synthesis route, so what is proven is the path a person
 * takes. Writing the column directly would prove the route and hide the two
 * places it can break — the picker not being wired, and the save not carrying
 * the pair.
 *
 * The microphone half cannot be driven here: Playwright can fake a camera and a
 * mic stream, but the transcription that follows costs a real API call per run.
 * The recorder's own guards are unit-tested; the button's presence and its
 * refusal state are what this file checks.
 */

/**
 * Open the Settings tab and return the Voice control.
 *
 * Retried as a unit because the first click can land BEFORE React has
 * hydrated: Playwright waits for the element to be actionable, not for its
 * handler to exist, so the click is swallowed and the tab never changes. The
 * symptom was "Voice not found" on a page that plainly had it.
 */
async function openVoiceField(page: import('@playwright/test').Page) {
  // getByRole, not getByLabel with exact:true — the accessible name computed
  // from a wrapping <label> carries the surrounding whitespace, so an exact
  // string comparison never matched a control the snapshot plainly showed as
  // `combobox "Voice"`. Role-based name matching normalises it.
  //
  // `exact` matters since a second control appeared beside it: picking a
  // streaming voice reveals "Voice quality", and a substring match then
  // resolves to two elements and fails in strict mode. Role-based name
  // matching normalises whitespace even when exact, which is why this works
  // where getByLabel with exact:true did not.
  const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
  await expect(async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(voice).toBeVisible({ timeout: 2_000 });
    // Generous: in dev the first visit to this route waits on a Turbopack
    // compile, measured well past 25 s. A packed build renders in milliseconds.
  }).toPass({ timeout: 90_000 });
  return voice;
}

/**
 * Save the agent and wait for the confirmation before doing anything else.
 *
 * Clicking Save and reloading straight away races the server action: the first
 * attempt at this test picked Silent, clicked, reloaded, and read Kore back —
 * the write had not landed yet. The toast is the acknowledgement.
 */
async function saveAgent(page: import('@playwright/test').Page) {
  await page
    .getByRole('button', { name: /^save$/i })
    .first()
    .click();
  await expect(page.getByText('Agent updated').first()).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  await requireLiveStack();
});

test.describe('Voice — picking a voice and hearing an agent', () => {
  // Well past the default 30 s: this journey opens two pages, saves twice, and
  // makes a REAL synthesis call — measured at 3.5–4.4 s on its own.
  test('an agent goes from silent to speaking, and back', async ({ page, request }) => {
    // setTimeout, not the options argument: the options form was silently
    // ignored here and every run died at the default 30 s, on an error that
    // pointed at the locator rather than at the clock.
    test.setTimeout(180_000);
    await page.goto('/agents');

    const editLink = page.locator('a[href*="/agents/"][href$="/edit"]').first();
    await expect(editLink, 'no agent to edit — the upstream journey failed').toBeVisible({
      timeout: 10_000,
    });
    const href = await editLink.getAttribute('href');
    const agentId = href!.split('/')[2]!;

    await page.goto(href!);

    // The model, reasoning and voice controls live on the Settings tab.
    const voice = await openVoiceField(page);

    // Silent is the default and the first option — a voice is a deliberate act.
    const originalValue = await voice.inputValue();
    await expect(voice.locator('option').first()).toHaveText('Silent');

    try {
      // ── Silent: the route refuses rather than picking a house voice ────────
      if (originalValue === '') {
        const mute = await request.post('/api/voice/speak', {
          data: { agentId, text: 'test' },
        });
        expect(mute.status(), 'a silent agent must not be given a voice by default').toBe(409);
        expect((await mute.json()).error).toBe('agent_has_no_voice');
      }

      // ── Choose one, save ───────────────────────────────────────────────────
      // The value carries the PROVIDER, not just the voice id. It used to be
      // "Kore" alone, with 'google' written as a literal in the save call —
      // which made every other provider unreachable from the UI, including the
      // streaming one the whole voice mode now depends on.
      //
      // A voice DIFFERENT from the current one, never a fixed name: an agent
      // that already carries the target leaves Save disabled ("No changes to
      // save") and the run dies ten seconds later on a click timeout that
      // points at the button rather than at the cause. Latent since this spec
      // was written; it surfaced the first time a run left Kore behind.
      const target = originalValue === 'google:Kore' ? 'google:Puck' : 'google:Kore';
      await voice.selectOption(target);
      await saveAgent(page);

      // Saved means: it survives a reload, not that a toast appeared.
      await page.reload();
      await expect(await openVoiceField(page)).toHaveValue(target);

      // ── And the agent now speaks ───────────────────────────────────────────
      const spoken = await request.post('/api/voice/speak', {
        data: { agentId, text: 'Bonjour, ceci est un test.', language: 'fr-FR' },
        timeout: 120_000,
      });
      expect(spoken.status(), await spoken.text().catch(() => '')).toBe(200);
      expect(spoken.headers()['content-type']).toBe('audio/wav');
      // Google cannot stream, so this response must NOT claim to: the client
      // branches on the header, and a false claim would send it down the Media
      // Source path with a finished file.
      expect(spoken.headers()['x-nodal-stream']).toBeUndefined();

      const audio = await spoken.body();
      // A real WAV whose header describes its payload — not an empty 200
      // dressed as success.
      expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audio.length).toBeGreaterThan(10_000);
      expect(audio.readUInt32LE(40)).toBe(audio.length - 44);
      expect(Number(spoken.headers()['x-nodal-latency-ms'])).toBeGreaterThan(0);
    } finally {
      // Put the agent back exactly as it was found — this suite runs against a
      // real workspace, and leaving a voice behind would bill every later reply.
      await page.goto(href!);
      const back = await openVoiceField(page);
      if ((await back.inputValue()) !== originalValue) {
        await back.selectOption(originalValue);
        await saveAgent(page);
        await page.reload();
        await expect(
          await openVoiceField(page),
          'FAILED TO RESTORE the agent voice — it will keep speaking, and billing',
        ).toHaveValue(originalValue);
      }
    }
  });

  test('a streaming voice sends its first bytes long before the last', async ({
    page,
    request,
  }) => {
    // The measurement this whole lot exists for. A finished file means silence
    // until the entire reply is rendered — 4 s, and the user's verdict on that
    // was that typing was faster. Streaming puts the first sound at ~0.5 s and
    // that figure does not grow with the length of the answer.
    test.setTimeout(180_000);
    await page.goto('/agents');
    const editLink = page.locator('a[href*="/agents/"][href$="/edit"]').first();
    await expect(editLink).toBeVisible({ timeout: 10_000 });
    const href = await editLink.getAttribute('href');
    const agentId = href!.split('/')[2]!;

    await page.goto(href!);
    const voice = await openVoiceField(page);
    const originalValue = await voice.inputValue();

    // Only where a MiniMax key exists — the picker lists a provider exactly
    // when this install can pay for it, so its absence is a skip, not a fail.
    const streaming = voice.locator('option[value^="minimax:"]').first();
    if ((await streaming.count()) === 0) {
      test.skip(true, 'no MiniMax key on this install — nothing streams here');
      return;
    }
    const streamingValue = (await streaming.getAttribute('value'))!;

    try {
      await voice.selectOption(streamingValue);
      await saveAgent(page);

      const started = Date.now();
      const spoken = await request.post('/api/voice/speak', {
        data: {
          agentId,
          text:
            'Le mode vocal permet de parler à un agent sans passer par le clavier. ' +
            'La transcription part chez le fournisseur, la réponse revient en texte, ' +
            'puis la synthèse la rend audible.',
          language: 'fr-FR',
        },
        timeout: 120_000,
      });
      expect(spoken.status(), await spoken.text().catch(() => '')).toBe(200);
      // The three headers the client branches on. Without the first it falls
      // back to buffering the whole reply and the gain silently disappears.
      expect(spoken.headers()['x-nodal-stream']).toBe('1');
      expect(spoken.headers()['content-type']).toBe('audio/mpeg');
      expect(spoken.headers()['x-accel-buffering']).toBe('no');
      // No content-length: the size is unknown until the vendor finishes, and a
      // wrong one truncates the audio.
      expect(spoken.headers()['content-length']).toBeUndefined();

      const audio = await spoken.body();
      const elapsed = Date.now() - started;
      // MP3 frames: either an ID3 tag or a frame sync. Proves it is audio and
      // not an error page served with the right content type.
      const head = audio.subarray(0, 3);
      const isMp3 =
        head.toString('ascii') === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
      expect(isMp3, 'the body is not MP3').toBe(true);
      expect(audio.length).toBeGreaterThan(10_000);
      // Delivered faster than it plays: ~17 s of speech in a few seconds of
      // wall clock. If this ever fails, something is buffering the response.
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await page.goto(href!);
      const back = await openVoiceField(page);
      if ((await back.inputValue()) !== originalValue) {
        await back.selectOption(originalValue);
        await saveAgent(page);
      }
    }
  });

  test('the chat composer offers the microphone', async ({ page }) => {
    await page.goto('/chat');
    // Over http://localhost the origin is secure, so the control is live. Over
    // LAN it renders disabled with the reason — the case that will actually
    // surprise someone, and the reason the button says it out loud.
    const mic = page.getByRole('button', { name: /record a message|voice input unavailable/i });
    await expect(mic).toBeVisible({ timeout: 15_000 });
  });

  test('the app does not forbid its own microphone', async ({ request }) => {
    // The bug this pins, found by using the feature: the app shipped
    // `Permissions-Policy: microphone=()`, which disables the device for the
    // WHOLE origin. getUserMedia then rejects with NotAllowedError whatever the
    // user clicks in the prompt — so the voice button reported "microphone
    // access was refused" and the refusal was ours. Nothing in the browser, the
    // component or the routes could have revealed it; only a header can.
    const res = await request.get('/chat');
    const policy = res.headers()['permissions-policy'] ?? '';
    expect(policy, 'the dashboard must be allowed to ask for the microphone').toMatch(
      /microphone=\(\s*self\s*\)/,
    );
    // The other two stay fully off — no feature asks for them, and widening
    // this header by copy-paste is exactly how they would drift open.
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');
  });

  test('the synthesis route refuses a foreign origin', async ({ request }) => {
    // Route handlers get no origin check from Next — server actions do. Without
    // the guard, any page in a browser already logged in here could burn the
    // install's speech quota, and CORS would not stop the request, only the
    // reading of its answer.
    const res = await request.post('/api/voice/speak', {
      headers: { origin: 'https://evil.example' },
      data: { agentId: '00000000-0000-0000-0000-000000000000', text: 'x' },
    });
    expect(res.status()).toBe(403);
  });
});
