#!/usr/bin/env node
// check-no-bench-studio.mjs — échoue si Bench Studio a laissé une trace dans une sortie de build.
//
//   node scripts/check-no-bench-studio.mjs apps/web/.next   après `pnpm build` (CI, job build)
//   node scripts/check-no-bench-studio.mjs pack             appelé par build-pack (pack-smoke, release:check)
//
// Le pourquoi et ce qui compte comme trace : scripts/lib/bench-studio-absent.mjs.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findStudioTraces } from './lib/bench-studio-absent.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/check-no-bench-studio.mjs <build output dir>');
  process.exit(2);
}
const dir = resolve(target);
if (!existsSync(dir)) {
  // Rien à vérifier n'est pas « vérifié » : le dire, et échouer.
  console.error(`check-no-bench-studio: ${dir} does not exist; nothing was built there`);
  process.exit(2);
}
const traces = findStudioTraces(dir);
if (traces.length > 0) {
  console.error(
    `Bench Studio is in ${dir}: it is a local tool and must never ship.\n` +
      traces.map((t) => `  ${t}`).join('\n') +
      '\nWas NODAL_BENCH_STUDIO=1 set for this build, or does a normal route import the studio?',
  );
  process.exit(1);
}
console.log(`✔ No Bench Studio trace in ${dir}`);
