/**
 * gen-changelog.ts — the docs changelog page IS the repository's CHANGELOG.md.
 *
 * Until #405 the page `content/docs/changelog.mdx` was a hand-kept copy of the
 * root `CHANGELOG.md`, and it stopped at 0.9.0 while the root carried 0.9.1: a
 * release PR had to write the same entries twice, and the second time was
 * forgotten. Now the page is written HERE, from the root file, before every
 * `next dev` / `next build` (see package.json scripts), like the reference
 * pages `gen-reference.ts` derives from the catalogs.
 *
 * What is kept from the root: everything from its first `## v…` heading down.
 * What is not: the root's own title and intro, replaced by the page's
 * frontmatter and one sentence — the root says "tagged on GitHub, upgrade in
 * place"; the page says the same, in its own words, once.
 *
 * Written as `.md`, not `.mdx`: release notes are prose with `{ }` and `<…>`
 * (a JSON example, a `<time>` placeholder) that the MDX compiler would read as
 * expressions and tags. In `.md` mode `{` is literal, and `<` is escaped
 * outside code spans, as the generated skill pages already do. The slug is the
 * file name, so `/docs/changelog` and the `meta.json` entry do not change.
 *
 * `NODAL_DOCS_GEN_OUT` redirects the output root, for the test that reads
 * what this script wrote without touching the checked-in tree.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const outRoot = process.env.NODAL_DOCS_GEN_OUT ?? join(here, '..');

/** Escape `<` outside code spans / fences so `<time>` renders as text. */
const escapeAnglesOutsideCode = (md: string): string =>
  md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/</g, '&lt;')))
    .join('');

/**
 * The releases section of the root changelog: from its first `## v` heading to
 * the end. Fails loud when the root has no such heading — a page generated
 * from nothing would be a changelog that says nothing (invariant #4).
 */
export function releasesOf(rootChangelog: string): string {
  const at = rootChangelog.search(/^## v/m);
  if (at === -1) throw new Error('gen-changelog: CHANGELOG.md has no "## v…" release heading');
  return rootChangelog.slice(at).trim();
}

export function renderChangelogPage(rootChangelog: string): string {
  return `---
title: Changelog
description: Notable releases of Nodal-Agents, newest first.
---

Notable releases, newest first — this page is the repository's \`CHANGELOG.md\`,
generated at build time. Pre-1.0: minor versions can carry breaking changes.
Every release is published to npm as \`nodal-agents\` and tagged on GitHub —
upgrade in place with \`nodal-agents update\` (your data is preserved).

${escapeAnglesOutsideCode(releasesOf(rootChangelog))}
`;
}

const root = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const docsDir = join(outRoot, 'content', 'docs');
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, 'changelog.md'), renderChangelogPage(root));
console.log(
  `[gen-changelog] wrote content/docs/changelog.md from CHANGELOG.md (${(root.match(/^## v/gm) ?? []).length} releases)`,
);
