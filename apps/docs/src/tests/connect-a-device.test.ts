// connect-a-device.test.ts — the "Connect a device" page against the protocol module (#947).
//
// The page is written for people, but what it lists is checked against the
// one protocol module (packages/shared/src/device-protocol.ts): an event or a
// gesture added there and not documented here turns this red.
//
// Mutation verified: the `announce` row removed from the events table, or the
// `hear` row from the gestures table → red.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_CAPABILITIES, DEVICE_GESTURES, DeviceEventSchema } from '@nodal-agents/shared';

const page = readFileSync(
  new URL('../../content/docs/guides/connect-a-device.mdx', import.meta.url),
  'utf8',
);

/** The rows of the markdown table that follows `## <heading>` / `### <heading>`. */
function tableUnder(heading: string): string[] {
  const at = page.indexOf(`\n## ${heading}\n`);
  expect(at, `section "${heading}"`).toBeGreaterThan(-1);
  const rest = page.slice(at + heading.length + 5);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
}

describe('the Connect a device page @cap:parler-par-canal-externe/moteur', () => {
  it('documents every event of the protocol, in the events table', () => {
    const firstCells = tableUnder('Events').map((r) => r.split('|')[1]!.trim());
    for (const option of DeviceEventSchema.options) {
      expect(firstCells).toContain(`\`${option.shape.type.value}\``);
    }
  });

  it('documents every gesture and every route of the protocol', () => {
    const rows = tableUnder('The protocol under the client');
    const byGesture = new Map(rows.map((r) => [r.split('|')[1]!.trim(), r]));
    for (const [gesture, routes] of Object.entries(DEVICE_GESTURES)) {
      const row = byGesture.get(gesture);
      expect(row, `gesture ${gesture}`).toBeDefined();
      for (const r of routes) expect(row).toContain(`${r.method} ${r.path}`);
    }
  });

  it('names every capability a device can declare, and its 20-line example fits in 20 lines', () => {
    for (const c of DEVICE_CAPABILITIES) expect(page).toContain(`'${c}'`);
    const example = /```js title="speaker\.mjs"\n([\s\S]*?)```/.exec(page)?.[1] ?? '';
    const lines = example.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThanOrEqual(20);
  });
});
