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
import {
  DEVICE_CAPABILITIES,
  DEVICE_GESTURES,
  DEVICE_PAIRING_GESTURES,
  DEVICE_RUN_STATES,
  DeviceEventSchema,
} from '@nodal-agents/shared';
import { connectSnippet } from '@nodal-agents/device-client/snippet';

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
    const stateRow = tableUnder('Events').find((r) => r.startsWith('| `state`'))!;
    for (const s of DEVICE_RUN_STATES) expect(stateRow).toContain(`\`${s}\``);
    // Its ordering rule (#1005): `seq`, and what the client does with it.
    expect(stateRow).toContain('`seq`');
    expect(stateRow).toMatch(/dropped/);
  });

  it('documents every gesture and every route of the protocol', () => {
    const rows = tableUnder('The protocol under the client');
    const byGesture = new Map(rows.map((r) => [r.split('|')[1]!.trim(), r]));
    for (const [gesture, routes] of Object.entries({
      ...DEVICE_PAIRING_GESTURES,
      ...DEVICE_GESTURES,
    })) {
      const row = byGesture.get(gesture);
      expect(row, `gesture ${gesture}`).toBeDefined();
      for (const r of routes) expect(row).toContain(`${r.method} ${r.path}`);
    }
  });

  it('names every capability a device can declare, and shows THE 20-line example, from its one source', () => {
    for (const c of DEVICE_CAPABILITIES) expect(page).toContain(`'${c}'`);
    const example = /```js title="speaker\.mjs"\n([\s\S]*?)```/.exec(page)?.[1] ?? '';
    // The same text Settings → Devices can show, here with the same-machine address.
    expect(example).toBe(connectSnippet('http://127.0.0.1:3001'));
    const lines = example.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('never answers a card without the person’s choice: not the snippet, not the reference client', () => {
    // Review of #1013: copied verbatim, a snippet that answers `choices[0]`
    // approves every action for every device that copies it.
    const reference = readFileSync(
      new URL('../../../../examples/device/reference-client.mjs', import.meta.url),
      'utf8',
    );
    for (const [name, code] of [
      ['snippet', connectSnippet('http://127.0.0.1:3001')],
      ['reference client', reference],
    ] as const) {
      const answers = [...code.matchAll(/\.answer\(([^)]*)\)/g)].map((m) => m[1]!.trim());
      expect(answers, name).toHaveLength(1);
      // The choice answered is a variable, never an index into the card's choices…
      expect(answers[0], name).toMatch(/^card\.cardId,\s*choice$/);
      expect(code, name).not.toMatch(/choices\s*\[/);
      // …and it is answered only when the person chose one.
      expect(code, name).toMatch(/if \(!?choice\)/);
    }
    expect(connectSnippet('x')).toMatch(
      /const choice = await askPerson\(card\.text, card\.choices\)/,
    );
  });
});
