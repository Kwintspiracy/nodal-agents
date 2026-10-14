// node-guard.ts — imported FIRST by index.ts. ES module imports evaluate in
// order, so this runs (and exits) before commander, chalk or any other import
// that could itself fail with an obscure error on an old Node.

import { nodeVersionProblem } from './node-version.ts';

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(problem + '\n');
  process.exit(1);
}
