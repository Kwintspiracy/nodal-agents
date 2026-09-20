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

  it('keeps a code span whole, even when it is shaped like a tag', () => {
    // Reviewer C, pass 1, C1. `stripMdx` used to remove JSX tags BEFORE
    // unwrapping code spans, so a placeholder written as code lost its
    // brackets and the tool served a command without its arguments:
    // "/ask — routes to a different agent" instead of
    // "/ask <agent-slug> <text> — routes to ...". The words eaten were the
    // only part of that line worth reading.
    const page = [
      '---',
      'title: Group commands',
      '---',
      '',
      '- `/ask <agent-slug> <text>` — routes to a different agent',
      "- `@bot_username <text>` — mention with the bot's username",
      '- `nodal-agents up --port <n>` starts the stack',
    ].join('\n');

    const text = sectionsOfPage('sample.mdx', page)[0]?.text ?? '';
    expect(text).toContain('/ask <agent-slug> <text>');
    expect(text).toContain('@bot_username <text>');
    expect(text).toContain('--port <n>');
  });

  it('protects a code span that wraps across the line break', () => {
    // The pages wrap prose at 80 columns, so a span lands across the wrap four
    // times today. Matched only within a line, those four are unprotected and
    // C1 comes back in a corner. One break is allowed, and no more: an
    // unmatched backtick must not swallow the rest of the page.
    const page = [
      '---',
      'title: Wrapped',
      '---',
      '',
      'Approve `@embedded-postgres/',
      '<platform>` and install again.',
      '',
      'A stray ` backtick opens nothing it cannot close within a line or two,',
      'and the rest of this paragraph is still here, with <Callout> gone.',
    ].join('\n');

    const text = sectionsOfPage('sample.mdx', page)[0]?.text ?? '';
    expect(text).toContain('@embedded-postgres/ <platform>');
    expect(text).toContain('the rest of this paragraph is still here');
    expect(text).not.toContain('<Callout>');
  });

  it('removes a JSX tag that spans several lines', () => {
    // Reviewer C, pass 1, C2. The tag removal ran line by line, so a `<Card>`
    // written across five lines never matched and was shipped verbatim in the
    // index: attribute names, hrefs and quotes, as if they were prose.
    const page = [
      '---',
      'title: Agents',
      'description: What an agent is.',
      '---',
      '',
      '## Related',
      '',
      '<Cards>',
      '  <Card',
      '    title="Orchestrators"',
      '    href="/docs/concepts/orchestrators"',
      '    description="How agents delegate work."',
      '  />',
      '</Cards>',
    ].join('\n');

    const stripped = stripMdx(splitFrontmatter(page).body);
    expect(stripped).not.toContain('<');
    expect(stripped).not.toContain('href=');
    expect(stripped).not.toContain('title=');

    // A card grid is navigation, not an answer: the tag goes and its attributes
    // with it, exactly as for a single-line tag. That leaves this section with
    // nothing to say, and an empty section is dropped rather than indexed as a
    // heading with no text.
    const sections = sectionsOfPage('sample.mdx', page);
    expect(sections.map((s) => s.heading)).toEqual(['Agents']);
    expect(sections[0]?.text).toBe('What an agent is.');
  });

  it('never lets a fenced line open a section', () => {
    // A shell comment inside a fence starts with `##`. Read line by line it
    // became a heading, and everything after it moved into a section that does
    // not exist on the site, under an anchor that scrolls nowhere.
    const page = [
      '---',
      'title: Commands',
      '---',
      '',
      '## Install',
      '',
      '```bash',
      '## not a heading',
      'npm i -g nodal-agents',
      '```',
      '',
      'Text after the fence.',
    ].join('\n');

    // No description and no lead prose, so the page has one section: Install.
    const sections = sectionsOfPage('sample.mdx', page);
    expect(sections.map((s) => s.heading)).toEqual(['Install']);
    const install = sections[0]?.text ?? '';
    expect(install).toContain('npm i -g nodal-agents');
    expect(install).toContain('Text after the fence.');
  });

  it('closes a fence with as many backticks as opened it', () => {
    // Reviewer C, pass 2, C1. The closing pattern was hard-coded to three, so a
    // four-backtick block (how one writes a fence that itself contains a fence)
    // opened a capture that ran to the next three-backtick line somewhere else
    // on the page, swallowing everything in between.
    const page = [
      '---',
      'title: Nested',
      '---',
      '',
      '## Writing a fence',
      '',
      '````md',
      '```bash',
      'npm i',
      '```',
      '````',
      '',
      'Prose after the outer fence.',
      '',
      '## A later section',
      '',
      'Still indexed.',
    ].join('\n');

    const sections = sectionsOfPage('sample.mdx', page);
    expect(sections.map((s) => s.heading)).toEqual(['Writing a fence', 'A later section']);
    // Exact, because the tell is the INNER closing fence: closed at three, the
    // outer block ends early and that ``` is consumed as the outer terminator,
    // so the example loses the line that makes it an example.
    expect(sections[0]?.text).toBe('```bash npm i ``` Prose after the outer fence.');
    expect(sections[1]?.text).toBe('Still indexed.');
  });

  it('removes an MDX comment, and leaves ordinary braces alone', () => {
    // Reviewer C, pass 2, C2. No page carries an MDX comment today; one written
    // tomorrow would have reached the index as prose. A bare `{expression}` is
    // deliberately left: the pages use braces as punctuation far more often
    // than as MDX, and eating them would be C1 in a third costume.
    const page = [
      '---',
      'title: Braces',
      'description: Placeholders.',
      '---',
      '',
      '{/* a note to the author, not to the reader */}',
      '',
      'The template resolves `{field.subfield}` against the incoming JSON.',
    ].join('\n');

    const text = sectionsOfPage('sample.mdx', page)[0]?.text ?? '';
    expect(text).not.toContain('a note to the author');
    expect(text).toContain('{field.subfield}');
  });

  it('ships no leftover markup anywhere in the index', () => {
    // Swept over the whole index rather than one page: both findings above
    // were "one page nobody looked at".
    //
    // What counts as markup, and what does not: an MDX component is
    // capitalised (`<Card`, `<Cards>`, `<Callout`), and an attribute or a
    // self-closing slash only ever comes from a tag. A lowercase angle
    // placeholder (`<agent-slug>`, `<package>`, `<sha>`) is the opposite case
    // entirely: it is code the reader needs, and eating it is the bug C1 was.
    const index = buildDocsIndex(contentDir);
    const offenders = index.sections.filter((s) =>
      /<[A-Z][A-Za-z]*[\s/>]|href=|className=|\/>/.test(s.text),
    );
    expect(
      offenders.map((s) => `${s.page} :: ${s.heading}`),
      'these sections still carry markup',
    ).toEqual([]);

    // The other half of the same sweep: the placeholders DID survive.
    const groups = index.sections.find(
      (s) => s.page === 'guides/telegram' && s.heading === 'How incoming messages become jobs',
    );
    expect(groups?.text).toContain('/ask <agent-slug> <text>');
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
