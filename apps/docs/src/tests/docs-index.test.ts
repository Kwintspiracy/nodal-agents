// docs-index.test.ts — the documentation index is DERIVED, and stays derived.
//
// Two things are proven here, and they are different things:
//   1. the generator turns a page into sections a search can rank (markup out,
//      headings kept, URLs that resolve on the site);
//   2. the committed `packages/tools/docs-index.json` is what the CURRENT pages
//      produce — so an edit to a guide that nobody regenerated fails here
//      rather than shipping an index that quietly describes last month's
//      product.
//
// The search itself is proven next to the tool that does it
// (packages/tools/src/tests/nodal-docs.test.ts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDocsIndex,
  serializeDocsIndex,
  listDocPages,
  sectionsOfPage,
  stripMdx,
  splitFrontmatter,
  anchorOf,
  GENERATED_SUBDIRS,
  EXCLUDED_PAGES,
  DOCS_URL_BASE,
} from '../../scripts/docs-index';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');
const contentDir = join(appRoot, 'content', 'docs');
const committedIndex = join(appRoot, '..', '..', 'packages', 'tools', 'docs-index.json');

describe('the documentation index @cap:consulter-l-aide/moteur', () => {
  it('is exactly what the current pages produce — the committed file, byte for byte', () => {
    const regenerated = serializeDocsIndex(buildDocsIndex(contentDir));
    const committed = readFileSync(committedIndex, 'utf8');
    // Named up front so the failure message says what to do, not just "strings
    // differ over 270 kB".
    expect(
      committed === regenerated,
      'packages/tools/docs-index.json is stale. Run `pnpm --filter @nodal-agents/docs gen` ' +
        'and commit the result.',
    ).toBe(true);
  });

  it('skips exactly the subdirectories gen-reference.ts owns, as .gitignore lists them', () => {
    // Drift here would be invisible: the index would either miss committed
    // pages or gain generated ones, and the freshness test above would then
    // pass or fail depending on whether the docs had been built.
    const gitignore = readFileSync(join(appRoot, '.gitignore'), 'utf8');
    const ignoredDocDirs = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/content/docs/reference/'))
      .map((l) => l.replace(/^\/content\/docs\//, '').replace(/\/$/, ''));

    expect([...GENERATED_SUBDIRS].sort()).toEqual(ignoredDocDirs.sort());

    const pages = listDocPages(contentDir);
    for (const dir of GENERATED_SUBDIRS) {
      expect(pages.some((p) => p.startsWith(`${dir}/`))).toBe(false);
    }
    for (const page of EXCLUDED_PAGES) {
      expect(pages).not.toContain(`${page}.mdx`);
    }
    // It still covers the guides and the dashboard reference — the pages that
    // say where to click.
    expect(pages).toContain('guides/telegram.mdx');
    expect(pages).toContain('guides/automations.mdx');
    expect(pages).toContain('reference/dashboard.mdx');
  });

  it('splits the Telegram guide into sections that carry the steps and a working URL', () => {
    const source = readFileSync(join(contentDir, 'guides', 'telegram.mdx'), 'utf8');
    const sections = sectionsOfPage('guides/telegram.mdx', source);

    const setup = sections.find((s) => s.heading === 'Set up the bot');
    expect(setup).toBeDefined();
    expect(setup?.url).toBe(`${DOCS_URL_BASE}/guides/telegram#set-up-the-bot`);
    expect(setup?.pageTitle).toBe('Telegram');
    // The real answer to the incident: the section names the tab AND the field.
    expect(setup?.text).toContain('Channels tab');
    expect(setup?.text).toContain('Bot token');
    // The lead section carries the frontmatter description, which is where the
    // page says what it is for.
    expect(sections[0]?.heading).toBe('Telegram');
    expect(sections[0]?.text).toContain('Bind a Telegram bot to an agent');
    expect(sections[0]?.url).toBe(`${DOCS_URL_BASE}/guides/telegram`);
  });

  it('strips MDX markup and keeps the words', () => {
    const page = [
      '---',
      'title: Sample',
      'description: A short description.',
      '---',
      '',
      "import { Callout } from 'fumadocs-ui/components/callout';",
      '',
      'Lead text with a [link](https://example.com) and **bold**.',
      '',
      '## First heading',
      '',
      '<Callout type="warn">Watch out for the thing.</Callout>',
      '',
      '1. Open the **Channels** tab.',
      '',
      '| Column | Other |',
      '| --- | --- |',
      '| value | second |',
      '',
      '```bash',
      'pnpm build',
      '```',
      '',
      '### A deeper heading',
      '',
      'Folded into its section.',
    ].join('\n');

    const front = splitFrontmatter(page);
    expect(front.title).toBe('Sample');
    expect(front.description).toBe('A short description.');

    const stripped = stripMdx(front.body);
    expect(stripped).not.toContain('import {');
    expect(stripped).not.toContain('<Callout');
    expect(stripped).not.toContain('https://example.com');
    expect(stripped).toContain('Watch out for the thing.');
    expect(stripped).toContain('link');

    const sections = sectionsOfPage('sample.mdx', page);
    expect(sections.map((s) => s.heading)).toEqual(['Sample', 'First heading']);
    expect(sections[0]?.text).toBe('A short description. Lead text with a link and bold.');

    const first = sections[1]?.text ?? '';
    expect(first).toContain('Open the Channels tab.');
    // A table keeps its cells, loses its pipes and its separator row.
    expect(first).toContain('Column Other');
    expect(first).not.toContain('|');
    expect(first).not.toContain('---');
    // A fenced command survives: it is often the answer.
    expect(first).toContain('pnpm build');
    // A deeper heading folds in as text rather than opening a section.
    expect(first).toContain('A deeper heading Folded into its section.');
  });

  it('builds the anchors the site actually serves', () => {
    // Expected values produced by the library fumadocs-core slugs headings
    // with, run against these exact strings:
    //   node --input-type=module -e "import S from 'github-slugger';
    //     const s = new S(); for (const h of [...]) { s.reset();
    //     console.log(h, '->', s.slug(h)); }"
    // github-slugger@2.0.0. Accents survive, and a run of spaces becomes a run
    // of dashes: both are how a heading with an em dash gets a double dash.
    expect(anchorOf('Set up the bot')).toBe('set-up-the-bot');
    expect(anchorOf('Who can talk to your bot?')).toBe('who-can-talk-to-your-bot');
    expect(anchorOf('Délégation & résultats')).toBe('délégation--résultats');
    expect(anchorOf('Delivery guard — no phantom sends')).toBe('delivery-guard--no-phantom-sends');
    expect(anchorOf('v0.7.8 — The Everywhere Release · Jul 12, 2026')).toBe(
      'v078--the-everywhere-release--jul-12-2026',
    );
  });
});
