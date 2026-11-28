// channel-link-state.arch.test.ts — every messaging channel writes the state of
// its link. A screen that shows a state for some channels and nothing for the
// others says "working" by omission: a channel added to CHANNELS whose manager
// never calls `recordChannelLink` with its name turns this red.
//
// The behaviour (refused, lost, back) is proven per channel by
// channels/link-state.test.ts; this proves no channel is left out of it.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '@nodal-agents/shared';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'tests') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The channels named as the third argument of a `recordChannelLink(` call. */
function channelsThatRecordTheirLink(): Set<string> {
  const found = new Set<string>();
  const call = /recordChannelLink\(\s*[^,]+,\s*[^,]+,\s*'([a-z]+)'/g;
  for (const file of sourceFiles(SRC_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(call)) found.add(m[1]!);
  }
  return found;
}

describe('every channel writes the state of its link', () => {
  it('each channel of CHANNELS has a manager that records its link', () => {
    const recording = channelsThatRecordTheirLink();
    const missing = CHANNELS.filter((c) => !recording.has(c));
    expect(missing, `channels whose link state is never written: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('the scan sees the calls it claims to see (no vacuous green)', () => {
    expect(channelsThatRecordTheirLink().size).toBeGreaterThanOrEqual(CHANNELS.length);
  });
});
