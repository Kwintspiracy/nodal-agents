// node-guard.ts — the one Node-version guard of every product entry (#628).
// The CLI (apps/cli/src/index.ts) and the runner (apps/runner/src/server.ts)
// each import it FIRST. ES modules evaluate their imports in order, so in the
// source this runs before the entry's other imports. In the published bundles
// it is weaker: tsup/esbuild hoist the EXTERNAL packages (execa, zod, hono...)
// above the bundled code, so those load before this check. It still turns the
// common failure (a bundled module using a Node 24 API) into one clear line.
// `scripts/tests/node-entry-guard.test.mjs` fails when an entry loses its import.

import { nodeVersionProblem } from './node-version';

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(problem + '\n');
  process.exit(1);
}
