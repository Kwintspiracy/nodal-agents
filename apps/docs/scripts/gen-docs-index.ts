/**
 * gen-docs-index.ts — write the documentation search index that the
 * `nodal_docs` built-in tool reads at runtime.
 *
 * Runs from this app's `gen` script, so `pnpm build` regenerates it. The
 * output is COMMITTED — `packages/tools` reads it with `fs` at runtime and a
 * fresh clone must work without having built the docs first — and
 * `src/tests/docs-index.test.ts` fails when the committed bytes no longer match
 * the current pages.
 *
 * It lands in `packages/tools/`, next to the package whose tool reads it, for
 * the same reason `packages/db/migrations/` sits next to the code that applies
 * them: the pack copies it to the pack root as a sibling of the bundle, and the
 * reader probes sibling-first, dev-layout-second (see `docs-index-store.ts`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocsIndex, serializeDocsIndex } from './docs-index';

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, '..', 'content', 'docs');
const outFile = join(here, '..', '..', '..', 'packages', 'tools', 'docs-index.json');

// The release notes come from the root file, like the docs page (#452).
const changelog = readFileSync(join(here, '..', '..', '..', 'CHANGELOG.md'), 'utf8');

const index = buildDocsIndex(contentDir, changelog);
writeFileSync(outFile, serializeDocsIndex(index), 'utf8');

console.log(
  `[gen-docs-index] ${String(index.sections.length)} sections from ${String(
    new Set(index.sections.map((s) => s.page)).size,
  )} pages → packages/tools/docs-index.json`,
);
