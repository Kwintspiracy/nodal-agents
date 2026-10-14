// pack-engines.mjs — the `engines` block of the published package.json.
// One source: the root package.json, so the pack manifest and the repo cannot
// disagree about the minimum Node (#628).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function packEngines(repoRoot) {
  const node = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')).engines?.node;
  if (typeof node !== 'string' || node === '') {
    throw new Error('package.json at the repo root declares no engines.node');
  }
  return { node };
}
