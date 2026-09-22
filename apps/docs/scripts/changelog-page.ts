/**
 * changelog-page.ts — the pure half of gen-changelog.ts: how the root
 * CHANGELOG.md becomes the docs page. No I/O here, so the tests can import it
 * without running the generator (a script imported at module top runs at
 * import time, before any test hook sets its output directory).
 */
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
