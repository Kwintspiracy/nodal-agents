/**
 * chat-voice.spec.ts — le micro push-to-talk du chat (#942), au navigateur.
 *
 * Ce que ce parcours prouve, sur un vrai Chromium avec un VRAI micro factice
 * (`--use-fake-device-for-media-stream` : un signal de test passe par
 * l'AudioContext et l'AudioWorklet de la page, comme une voix) :
 *   — tenir, parler, relâcher : des morceaux de PCM partent PENDANT que le
 *     bouton est tenu, puis la fin ; la transcription paraît dans le fil avec
 *     « Spoken · 0:03 », la réponse porte « Speaking » et sa voix joue ;
 *   — glisser hors du bouton puis relâcher : « Cancelled. Nothing was sent. »,
 *     un DELETE du tour, et aucune fin ;
 *   — le micro refusé par le navigateur : « Microphone blocked… », sans boîte
 *     native, et rien n'est envoyé.
 *
 * Aucun runner ni modèle : les routes du tour sont interceptées À LA PORTE WEB
 * (`/api/voice/turns…`), et la fin écrit en base les deux tours que le runner
 * aurait écrits (la demande DITE avec sa durée, puis la réponse), pour que le
 * fil relu les montre. Ce que le runner fait du tour est prouvé côté moteur
 * (apps/runner/src/tests/routes/voice-turn.test.ts, #958).
 *
 * Conventions : requireLiveStack() en beforeAll, storageState via la config,
 * lignes semées supprimées en afterAll.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
  permissions: ['microphone'],
});

let acting: { userId: string; entityId: string };
let conversationId: string;
let agentId: string;
const created: { conversationIds: string[]; agentIds: string[] } = {
  conversationIds: [],
  agentIds: [],
};

test.beforeAll(async () => {
  await requireLiveStack();
  acting = await resolveActingUser();
  const { agents, conversations } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  const suffix = testSlugSuffix();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: 'Alfred',
        slug: `e2e-voice-${suffix}`,
        personality: 'E2E fixture — never executed.',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    created.agentIds.push(agent!.id);
    agentId = agent!.id;
    const [conversation] = await db
      .insert(conversations)
      .values({
        entityId: acting.entityId,
        agentId: agent!.id,
        title: `Voice ${suffix}`,
        origin: 'user',
        channel: 'dashboard',
      })
      .returning({ id: conversations.id });
    created.conversationIds.push(conversation!.id);
    conversationId = conversation!.id;
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  const { chatMessages, conversations, agents, inArray } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    if (created.conversationIds.length > 0) {
      await db
        .delete(chatMessages)
        .where(inArray(chatMessages.conversationId, created.conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, created.conversationIds));
    }
    if (created.agentIds.length > 0) {
      await db.delete(agents).where(inArray(agents.id, created.agentIds));
    }
  } finally {
    await close();
  }
});

/** Du silence, en WAV 16 bits mono à 8 kHz : une réponse qui joue. Assez longue
 * (20 s) pour jouer encore quand le fil relu paraît, même en `next dev` qui
 * compile à la première visite ; le parcours la coupe par Stop. */
function silentWavBase64(seconds: number): string {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf.toString('base64');
}

type Seen = { method: string; path: string; bytes: number };

/** Les routes du tour, interceptées à la porte web ; chaque requête est notée. */
async function stubVoiceRoutes(
  page: Page,
  onEnd: (route: Route) => Promise<void>,
): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.route('**/api/voice/turns**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    seen.push({
      method: req.method(),
      path,
      bytes: req.postDataBuffer()?.length ?? 0,
    });
    if (req.method() === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"cancelled":true}',
      });
    } else if (path === '/api/voice/turns') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{"turnId":"e2e-turn"}',
      });
    } else if (path.includes('/chunks/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"received":1}' });
    } else if (path.endsWith('/end')) {
      await onEnd(route);
    } else {
      await route.fulfill({ status: 500, body: 'unexpected' });
    }
  });
  return seen;
}

/** Ce que la page a demandé à jouer, noté avant tout script de la page. */
async function recordPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __played: string[] };
    w.__played = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.__played.push(this.src.slice(0, 22));
      return play.call(this);
    };
  });
}

async function micCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('composer-mic').boundingBox();
  if (!box) throw new Error('the microphone button has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('the chat microphone @cap:parler-a-un-agent/ecran', () => {
  test('hold, speak, release: chunks while held, the transcript "Spoken", the reply plays', async ({
    page,
  }) => {
    await recordPlayback(page);
    const transcript = `What is the capital of Australia? ${testSlugSuffix()}`;
    const seen = await stubVoiceRoutes(page, async (route) => {
      // Ce que le runner aurait écrit pendant le tour : la demande DITE, puis la réponse.
      const { chatMessages } = await import('@nodal-agents/db');
      const { db, close } = makeDbClient();
      try {
        await db.insert(chatMessages).values({
          entityId: acting.entityId,
          agentId,
          conversationId,
          role: 'user',
          content: transcript,
          spokenMs: 3000,
        });
        await db.insert(chatMessages).values({
          entityId: acting.entityId,
          agentId,
          conversationId,
          role: 'assistant',
          content: 'Canberra, not Sydney.',
        });
      } finally {
        await close();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          outcome: 'replied',
          transcript,
          durationMs: 3000,
          reply: 'Canberra, not Sydney.',
          spawnedJobId: null,
          stopped: false,
          cutReason: null,
          audio: { mimeType: 'audio/wav', base64: silentWavBase64(20) },
          speechError: null,
        }),
      });
    });

    await page.goto(`/chat/${conversationId}`);
    const mic = page.getByTestId('composer-mic');
    await expect(mic).toHaveAccessibleName('Hold to talk');
    await mic.hover();
    await expect(page.getByTestId('voice-tooltip')).toBeVisible();

    const { x, y } = await micCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(mic).toHaveAccessibleName('Listening, release to send');
    await expect(page.getByText('Release to send. Slide away to cancel.')).toBeVisible();
    // Des morceaux arrivent PENDANT que le bouton est tenu : la souris n'est
    // pas encore relâchée, et deux morceaux non vides sont déjà passés.
    await expect
      .poll(() => seen.filter((s) => s.path.includes('/chunks/') && s.bytes > 0).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(2);
    expect(seen.some((s) => s.path.endsWith('/end'))).toBe(false);
    await page.mouse.up();

    // La transcription, à droite, avec sa durée dite ; la réponse qui parle.
    await expect(page.getByText(transcript)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('feed-spoken')).toHaveText('Spoken · 0:03');
    await expect(page.getByText('Speaking', { exact: true })).toBeVisible();
    const stop = page.getByTestId('composer-stop-speaking');
    await expect(stop).toHaveAccessibleName('Stop speaking');
    const played = await page.evaluate(
      () => (window as unknown as { __played: string[] }).__played,
    );
    expect(played).toEqual(['data:audio/wav;base64,']);

    // Les morceaux sont partis DANS L'ORDRE, puis la fin, et rien d'autre.
    const order = seen.map((s) => `${s.method} ${s.path}`);
    const chunkPaths = order.filter((o) => o.includes('/chunks/'));
    expect(chunkPaths).toEqual(
      chunkPaths.map((_, i) => `POST /api/voice/turns/e2e-turn/chunks/${String(i)}`),
    );
    expect(order[0]).toBe('POST /api/voice/turns');
    expect(order.at(-1)).toBe('POST /api/voice/turns/e2e-turn/end');
    expect(order.some((o) => o.startsWith('DELETE'))).toBe(false);
    // Du PCM 16 bits : chaque morceau a un nombre pair d'octets.
    expect(seen.filter((s) => s.path.includes('/chunks/')).every((s) => s.bytes % 2 === 0)).toBe(
      true,
    );

    // Stop fait taire la réponse : Envoyer revient, la pastille s'en va.
    await stop.click();
    await expect(page.getByTestId('composer-send')).toBeVisible();
    await expect(page.getByText('Speaking', { exact: true })).toHaveCount(0);
  });

  test('slide away and release: "Cancelled. Nothing was sent." and a DELETE, no end', async ({
    page,
  }) => {
    const seen = await stubVoiceRoutes(page, async (route) => {
      await route.fulfill({ status: 500, body: 'end must not be called' });
    });
    await page.goto(`/chat/${conversationId}`);
    const mic = page.getByTestId('composer-mic');
    const { x, y } = await micCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(mic).toHaveAccessibleName('Listening, release to send');
    await expect
      .poll(() => seen.filter((s) => s.path.includes('/chunks/')).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    await page.mouse.move(x, y - 200, { steps: 5 });
    await page.mouse.up();

    await expect(page.getByText('Cancelled. Nothing was sent.')).toBeVisible();
    await expect
      .poll(() => seen.map((s) => `${s.method} ${s.path}`))
      .toContain('DELETE /api/voice/turns/e2e-turn');
    expect(seen.some((s) => s.path.endsWith('/end'))).toBe(false);
    await expect(mic).toHaveAccessibleName('Hold to talk');
  });

  test('microphone refused by the browser: "Microphone blocked…", no dialog, nothing sent', async ({
    page,
  }) => {
    // Le refus du navigateur, tel qu'il arrive : un `NotAllowedError`.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const seen = await stubVoiceRoutes(page, async (route) => {
      await route.fulfill({ status: 500, body: 'end must not be called' });
    });
    await page.goto(`/chat/${conversationId}`);
    const { x, y } = await micCenter(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();

    await expect(
      page.getByText(
        'Microphone blocked. Allow it for this site in your browser, then hold the button again.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('composer-mic')).toHaveAccessibleName('Microphone blocked');
    expect(seen).toEqual([]);
    expect(dialogs).toEqual([]);
  });
});
