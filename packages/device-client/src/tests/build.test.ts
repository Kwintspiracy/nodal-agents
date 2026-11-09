// build.test.ts — the built client is ONE file with no dependency, and it works (#950).
//
// The build is run into a temporary folder; the test then reads what a device
// project would copy, and imports the built JavaScript itself to pair and
// connect against a scripted Nodal.
//
// Mutations verified: `bundle: false` in scripts/build.mjs (the .mjs keeps its
// import of the generated module) → red; the protocol types not inlined in the
// .d.ts (it imports ./protocol.generated.ts) → the build throws, red.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEVICE_EVENT_TYPES_FOR_TEST } from './device-event-types.ts';
import { fakeNodal, liveStream, until } from './fake-nodal.ts';
// @ts-expect-error — a plain .mjs build script, no declarations
import { buildClient } from '../../scripts/build.mjs';

const out = mkdtempSync(join(tmpdir(), 'nodal-device-build-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the built client file @cap:parler-par-canal-externe/moteur', () => {
  it('is one .mjs and one .d.ts that import nothing, and the .d.ts names every protocol event', async () => {
    const { js, dts } = (await buildClient(out)) as { js: string; dts: string };
    const code = readFileSync(js, 'utf8');
    const types = readFileSync(dts, 'utf8');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bimport\(|\brequire\(/);
    expect(types).not.toMatch(/\bfrom\s+['"]|\bimport\(/);
    for (const t of DEVICE_EVENT_TYPES_FOR_TEST) expect(types).toContain(`type: "${t}"`);
    expect(types).toContain('export declare function connect(');
    expect(types).toContain('export declare function pair(');
    expect(statSync(js).size).toBeLessThan(64 * 1024);
  }, 60_000);

  it('the built file pairs and hears a card, as the source does', async () => {
    const mod = (await import(
      pathToFileURL(join(out, 'nodal-device.mjs')).href
    )) as typeof import('../nodal-device.ts');
    const live = liveStream();
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p',
            deviceCode: 'dc',
            userCode: '246810',
            expiresInSeconds: 600,
            intervalSeconds: 0,
          },
          { status: 201 },
        ),
      'POST /api/devices/pair/poll': () =>
        Response.json({ status: 'paired', deviceId: 'd1', token: 'ndv_x', conversationId: 'c1' }),
      'GET /api/devices/:id/events': () => live.response,
    });
    const pairing = await mod.pair('http://n', {
      name: 'Built',
      capabilities: ['speaker'],
      fetch: nodal.fetch,
    });
    const session = await pairing.done();
    const device = mod.connect('http://n', session, { fetch: nodal.fetch });
    const cards: unknown[] = [];
    device.on('card', (c) => cards.push(c));
    live.send(
      'card',
      { type: 'card', cardId: 'k', kind: 'approval', text: 'Approve?', choices: [] },
      'e1',
    );
    await until(() => cards.length === 1);
    expect(cards[0]).toMatchObject({ cardId: 'k', kind: 'approval' });
    device.close();
  }, 60_000);
});
