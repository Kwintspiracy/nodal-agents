/**
 * A device pairs from its own side, the owner confirms it in Settings → Devices,
 * and removing it cuts its key (#946).
 *
 * The device is a SCRIPT: it calls the runner's pairing routes as any device
 * would, with no key, then uses the key it is handed. Nothing is mocked on the
 * page: the section reads the runner, the buttons call it.
 *
 *   1. no device yet: the three steps and the address a device connects to;
 *   2. the device asks to pair: its request appears with ITS code;
 *   3. Confirm and pair: the device's next poll gets its key, its stream
 *      opens, and the row says Connected;
 *   4. Remove asks first (ConfirmDialog);
 *   5. removed: the toast, the device's open stream ends by itself, and its
 *      key is refused; then an expired request shows its card, and Dismiss
 *      takes it away.
 *
 * The runner is reached at E2E_RUNNER_URL (default http://127.0.0.1:3001), the
 * base at NODALAI_E2E_DB_URL like every other spec. E2E_SHOTS_DIR, when set,
 * receives a viewport screenshot of each state.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { and, devicePairings, devices, eq, isNull, like } from '@nodal-agents/db';
import { makeDbClient, requireLiveStack } from './helpers.ts';

const RUNNER = process.env['E2E_RUNNER_URL'] ?? 'http://127.0.0.1:3001';
const SHOTS = process.env['E2E_SHOTS_DIR'];
const NAME = 'E2E Living room speaker';

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function device(
  method: string,
  route: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${RUNNER}${route}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

test.beforeAll(async () => {
  await requireLiveStack();
  // What an earlier run of this spec may have left: its requests, its device.
  const { db, close } = makeDbClient();
  try {
    await db.delete(devicePairings).where(like(devicePairings.name, 'E2E %'));
    await db
      .update(devices)
      .set({ revokedAt: new Date(), tokenHash: null })
      .where(and(like(devices.name, 'E2E %'), isNull(devices.revokedAt)));
  } finally {
    await close();
  }
});

test.describe('Settings → Devices: pair, confirm, remove @cap:parler-par-canal-externe/ecran', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1280, height: 860 } });

  test('a scripted device pairs, gets its key once, and loses it when removed', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ── 1. No device yet ─────────────────────────────────────────────────────
    await page.goto('/settings?page=devices');
    const section = page.getByTestId('devices-section');
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Devices', exact: true })).toBeVisible();
    const empty = page.getByTestId('devices-empty');
    await expect(empty).toContainText(
      'No device yet. A device pairs from its own side, in three steps:',
    );
    await expect(empty).toContainText(
      'The device asks Nodal for a pairing code, then shows it or says it aloud.',
    );
    // The address is the RUNNER's: the device routes are served there.
    const runnerPort = new URL(RUNNER).port;
    await expect(page.getByTestId('device-address')).toContainText(`:${runnerPort}`);
    await shot(page, '1-no-device');

    // ── 2. The device asks to pair ───────────────────────────────────────────
    const started = await device('POST', '/api/devices/pair', {
      body: { name: NAME, capabilities: ['microphone', 'speaker'], protocolVersion: 1 },
    });
    expect(started.status).toBe(201);
    const pairingId = String(started.json['pairingId']);
    const userCode = String(started.json['userCode']);
    const deviceCode = String(started.json['deviceCode']);

    const card = page.getByTestId(`pairing-request-${pairingId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('pairing-code')).toHaveText(
      `${userCode.slice(0, 3)} ${userCode.slice(3)}`,
    );
    await expect(card).toContainText(NAME);
    await expect(card).toContainText('Microphone');
    await expect(card).toContainText('Speaker');
    await expect(card).toContainText('It will talk with');
    await expect(card.getByTestId('pairing-expiry')).toContainText(/expires in \d+:\d\d/);
    // The red counter on "Devices" while it waits (the sidebar's own pace).
    await page.reload();
    await expect(page.getByRole('link', { name: /^Devices\s*1$/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(card).toBeVisible();
    await shot(page, '2-request');

    // The device is still waiting.
    expect((await device('POST', '/api/devices/pair/poll', { body: { deviceCode } })).json).toEqual(
      { status: 'pending' },
    );

    // ── 3. Confirm and pair ──────────────────────────────────────────────────
    await card.getByRole('button', { name: 'Confirm and pair' }).click();
    await expect(card).toBeHidden({ timeout: 15_000 });
    // The pill goes with the request: nothing waits any more.
    await expect(page.getByRole('link', { name: 'Devices', exact: true })).toBeVisible();

    await new Promise((r) => setTimeout(r, 2_100));
    const paired = await device('POST', '/api/devices/pair/poll', { body: { deviceCode } });
    expect(paired.status).toBe(200);
    expect(paired.json['status']).toBe('paired');
    const token = String(paired.json['token']);
    const deviceId = String(paired.json['deviceId']);
    expect(token).toMatch(/^ndv_[A-Za-z0-9_-]{43}$/);
    // Once.
    await new Promise((r) => setTimeout(r, 2_100));
    expect((await device('POST', '/api/devices/pair/poll', { body: { deviceCode } })).status).toBe(
      410,
    );

    // The device opens its stream with its key.
    const stream = await fetch(`${RUNNER}/api/devices/${deviceId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let streamEnded = false;
    const drained = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      streamEnded = true;
    })();

    const row = page.getByTestId(`device-row-${deviceId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(NAME);
    await expect(row).toContainText('Connected', { timeout: 15_000 });
    await expect(row).toContainText(/Talks with .+ · paired .+/);
    await expect(page.getByText('A device sees only its own conversation.')).toBeVisible();
    await shot(page, '3-paired');

    // ── 4. Remove asks first ─────────────────────────────────────────────────
    await row.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Remove ${NAME}?`);
    await expect(dialog).toContainText(
      'Its key stops working at once, and a reply it is playing is cut.',
    );
    await shot(page, '4-remove-dialog');

    // ── 5. Removed: the toast, the stream cut, the key refused ───────────────
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText(`${NAME} removed. Its key no longer works.`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(row).toBeHidden({ timeout: 15_000 });
    await shot(page, '5a-removed-toast');
    await Promise.race([drained, new Promise((r) => setTimeout(r, 10_000))]);
    expect(streamEnded).toBe(true);
    expect(await device('POST', `/api/devices/${deviceId}/conversation`, { token })).toEqual({
      status: 401,
      json: { error: 'device_token_invalid' },
    });

    // ── 5. An expired request ────────────────────────────────────────────────
    const late = await device('POST', '/api/devices/pair', {
      body: { name: `${NAME} 2`, capabilities: ['speaker'], protocolVersion: 1 },
    });
    expect(late.status).toBe(201);
    const lateId = String(late.json['pairingId']);
    const { db, close } = makeDbClient();
    try {
      await db
        .update(devicePairings)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(devicePairings.id, lateId));
    } finally {
      await close();
    }
    const expired = page.getByTestId(`pairing-expired-${lateId}`);
    await expect(expired).toBeVisible({ timeout: 15_000 });
    await expect(expired).toContainText(`A pairing request expired. ${NAME} 2, from`);
    await expect(expired).toContainText('was not confirmed within 10 minutes.');
    await shot(page, '5b-expired');
    await expired.getByRole('button', { name: 'Dismiss' }).click();
    await expect(expired).toBeHidden({ timeout: 15_000 });
  });
});
