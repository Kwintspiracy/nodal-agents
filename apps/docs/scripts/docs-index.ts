/**
 * docs-index.ts — turn the shipped documentation into a knowledge base the
 * runtime can read.
 *
 * `gen-reference.ts`, next door, walks the product catalogs and WRITES docs
 * pages. This module walks the other way: it READS the hand-written pages and
 * produces one flat JSON index of sections, which the `nodal_docs` built-in
 * tool searches at runtime. Same principle, opposite direction — the
 * documentation stays the single source, and nothing about the platform is
 * re-typed into a prompt or a FAQ.
 *
 * WHICH PAGES. Every committed `.mdx` page under `content/docs`, MINUS the five
 * subdirectories `gen-reference.ts` owns (they are gitignored — see
 * `apps/docs/.gitignore`). Including them would make the index depend on
 * whether the generator had run, so a fresh clone and a built tree would
 * disagree and the freshness test would be a coin toss. What those pages carry
 * — the connector/model/skill catalogs — is already in the prompt from the
 * catalogs themselves; what they never carry is "where do I click", which is
 * exactly what this index is for.
 *
 * HOW IT SPLITS. One section per `##` heading, with everything before the
 * first one kept as the page's lead section. `###` and below fold into their
 * enclosing `##`, so a section is a readable answer rather than a fragment.
 *
 * The output is DERIVED, never hand-edited: `pnpm build` regenerates it (via
 * the `gen` script of this app) and `docs-index.test.ts` fails if the committed
 * file and the current pages have drifted apart.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Where the site serves the docs from (`basePath` in `next.config.mjs`). */
export const DOCS_URL_BASE = '/nodal-agents/docs';

/**
 * Subdirectories of `content/docs` written by `gen-reference.ts` and ignored by
 * git. Kept out of the index on purpose (see the module doc). The list is
 * asserted against `apps/docs/.gitignore` by the test, so the two cannot drift.
 */
export const GENERATED_SUBDIRS = [
  'reference/system-skills',
  'reference/connectors',
  'reference/mcp',
  'reference/models',
  'reference/builtin-tools',
] as const;

/**
 * Pages kept out of the index although they are committed.
 *
 * `changelog` is release history, not an answer: it says what shipped in
 * v0.7.8, never where to click today. Left in, it won queries it had no
 * business winning ("schedule a task every morning" ranked a release note
 * above the automations guide), because a long page repeating product nouns
 * beats a short page that answers the question.
 */
export const EXCLUDED_PAGES = ['changelog'] as const;

/** One searchable slice of the documentation. */
export interface DocsSection {
  /** Page path below `content/docs`, without extension: `guides/telegram`. */
  page: string;
  /** The page's frontmatter title: `Telegram`. */
  pageTitle: string;
  /** This section's heading, or the page title for a lead section. */
  heading: string;
  /** Site URL with its anchor: `/nodal-agents/docs/guides/telegram#set-up-the-bot`. */
  url: string;
  /** The section's prose, markup removed. */
  text: string;
}

export interface DocsIndex {
  /** Who writes this file, so a reader who opens it knows not to edit it. */
  generator: string;
  sections: DocsSection[];
}

const GENERATOR = 'apps/docs/scripts/gen-docs-index.ts';

// ─── Reading the tree ─────────────────────────────────────────────────────────

/** Every `.mdx` page below `dir`, as paths relative to it, sorted. */
export function listDocPages(dir: string): string[] {
  const out: string[] = [];
  const skip = new Set<string>(GENERATED_SUBDIRS.map((d) => d.replace(/\//g, sep)));

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        if (skip.has(rel)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
        const posix = rel.split(sep).join('/');
        if ((EXCLUDED_PAGES as readonly string[]).includes(posix.replace(/\.mdx$/, ''))) continue;
        out.push(posix);
      }
    }
  };

  walk(dir);
  return out.sort();
}

// ─── Stripping the markup ─────────────────────────────────────────────────────

interface Frontmatter {
  title: string;
  description: string;
  body: string;
}

/**
 * Split the YAML frontmatter off a page. Only `title` and `description` are
 * read — they are the only keys the pages carry, and a full YAML parser here
 * would be a dependency for two string fields.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { title: '', description: '', body: normalized };
  const read = (key: string): string => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1] ?? '');
    const raw = (line?.[1] ?? '').trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  };
  return {
    title: read('title'),
    description: read('description'),
    body: normalized.slice(match[0].length),
  };
}

/**
 * Markdown/MDX → plain text. Headings keep their `#` marks: the caller splits
 * on them afterwards.
 *
 * ORDER IS THE WHOLE PROBLEM, and two Reviewer C findings on the first pass of
 * this file were both about getting it wrong:
 *
 *   - Code came LAST, so removing JSX tags first ate the brackets of a
 *     placeholder written as code. `` `/ask <agent-slug> <text>` `` reached the
 *     index as `/ask`, and the tool served a command stripped of its arguments
 *     with every appearance of being complete.
 *   - Tags were removed LINE BY LINE, so a `<Card>` written across five lines
 *     never matched and shipped verbatim: attribute names, hrefs and quotes
 *     presented as prose.
 *
 * So code is taken out of the way FIRST, as placeholders, and put back LAST.
 * Everything in between is free to be aggressive, and a fenced block can no
 * longer be mistaken for anything: a `## comment` inside one used to open a
 * section under an anchor that scrolls nowhere.
 *
 * Removed: import/export statements, JSX and HTML tags (the tag, never the text
 * around it), fence markers (the code itself stays, because a command line is
 * often the answer), list bullets, table pipes, emphasis, link targets.
 */
export function stripMdx(body: string): string {
  const code: string[] = [];
  // U+0001 cannot appear in a docs page and is matched by no rule below, so a
  // placeholder survives every pass intact.
  const keep = (text: string): string => `\u0001${String(code.push(text) - 1)}\u0001`;

  let work = body;

  // 1. Fenced blocks. Their newlines are folded into spaces on the way in:
  //    restored at the end they would otherwise reintroduce lines, and one of
  //    them starting with `##` would open a section that does not exist.
  work = work.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_all, inner: string) =>
    keep(
      inner
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .join(' ')
        // A shell comment opens with `#`. Restored at the start of a line it
        // would be read as a heading, so the marker goes and the comment stays.
        .replace(/^#+\s*/, ''),
    ),
  );

  // 2. Inline code spans, before anything can look inside them.
  //
  //    ONE line break is allowed inside a span, because the pages wrap prose at
  //    80 columns and a span lands across the wrap four times today. Matching
  //    only single-line spans would leave those four unprotected, which is C1
  //    again in a corner; matching any number of line breaks would let a stray
  //    backtick swallow the rest of the page. The break folds to a space, for
  //    the same reason a fence does: restored at the start of a line, code can
  //    otherwise be read as markup.
  work = work.replace(/`([^`\n]*\n?[^`\n]*)`/g, (_all, inner: string) =>
    keep(inner.replace(/\s*\n\s*/g, ' ')),
  );

  // 3. `import { Callout } from 'fumadocs-ui/components/callout';`
  work = work
    .split('\n')
    .filter((l) => !/^\s*(import|export)\s/.test(l))
    .join('\n');

  // 4. JSX and HTML tags, across the WHOLE text so a tag written over several
  //    lines matches. `[^<>]` rather than `[^>]` keeps a malformed tag from
  //    swallowing the rest of the page.
  work = work.replace(/<\/?[A-Za-z][^<>]*>/g, ' ');

  // 5. Links and images: the label stays, the target goes.
  work = work.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  work = work.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 6. Line-anchored markup: tables, bullets, quotes.
  const lines: string[] = [];
  for (const raw of work.split('\n')) {
    let text = raw;
    if (/^\s*\|/.test(text)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(text)) continue;
      text = text.replace(/\|/g, ' ');
    }
    text = text.replace(/^\s*[-*+]\s+/, '');
    text = text.replace(/^\s*\d+\.\s+/, '');
    text = text.replace(/^\s*>\s?/, '');
    lines.push(text.trimEnd());
  }
  work = lines.join('\n');

  // 7. Emphasis.
  work = work.replace(/\*\*([^*]+)\*\*/g, '$1');

  // 8. The code, back where it was.
  return work.replace(/\u0001(\d+)\u0001/g, (_all, i: string) => code[Number(i)] ?? '');
}

/**
 * The anchor fumadocs actually serves for a heading.
 *
 * fumadocs-core slugs headings with `github-slugger` (its own dependency), and
 * that library has two behaviours an "obvious" implementation gets wrong, both
 * of which would produce URLs that scroll nowhere:
 *   - accented letters are KEPT (`Délégation` → `délégation`), not folded;
 *   - runs of spaces are NOT collapsed — each surviving space becomes one
 *     dash, so a heading with an em dash gets a DOUBLE dash
 *     (`Delivery guard — no phantom sends` → `delivery-guard--no-phantom-sends`).
 *
 * Reproduced here rather than imported because `github-slugger` is a
 * transitive dependency of fumadocs-core, not a declared one of this app. The
 * expectations in `docs-index.test.ts` are the real library's output, so a
 * divergence is caught rather than assumed away.
 */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/** `guides/telegram.mdx` → `guides/telegram`; `index.mdx` → `` (the docs root). */
function pageOf(relPath: string): string {
  const withoutExt = relPath.replace(/\.mdx$/, '');
  return withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '');
}

/** Collapse runs of whitespace, keeping paragraph breaks readable as one space. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ─── Building the index ───────────────────────────────────────────────────────

/** Split one page into its sections. Exported for the test. */
export function sectionsOfPage(relPath: string, source: string): DocsSection[] {
  const { title, description, body } = splitFrontmatter(source);
  const page = pageOf(relPath);
  const pageTitle = title !== '' ? title : page;
  const pageUrl = page === '' ? DOCS_URL_BASE : `${DOCS_URL_BASE}/${page}`;

  const stripped = stripMdx(body);
  const sections: DocsSection[] = [];

  let heading = pageTitle;
  let anchor = '';
  // The page's own description leads the first section: it is the one line the
  // author wrote to say what the page is for, and it carries words the body
  // often assumes (a page titled "Telegram" whose body never repeats "bot").
  let buffer: string[] = description !== '' ? [description] : [];

  const flush = (): void => {
    const text = squash(buffer.join('\n'));
    if (text === '') return;
    sections.push({
      page,
      pageTitle,
      heading,
      url: anchor === '' ? pageUrl : `${pageUrl}#${anchor}`,
      text,
    });
  };

  for (const line of stripped.split('\n')) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      heading = squash(h2[1] ?? '');
      anchor = anchorOf(heading);
      buffer = [];
      continue;
    }
    // A deeper heading stays inside its section, as text — its words are worth
    // matching on, and promoting it would shred sections into fragments.
    buffer.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flush();

  return sections;
}

/**
 * Walk `contentDir` and produce the index. Deterministic: pages are sorted, and
 * sections keep their order within a page, so two runs over the same tree give
 * the same bytes.
 */
export function buildDocsIndex(contentDir: string): DocsIndex {
  const sections: DocsSection[] = [];
  for (const relPath of listDocPages(contentDir)) {
    const source = readFileSync(join(contentDir, relPath), 'utf8');
    sections.push(...sectionsOfPage(relPath, source));
  }
  return { generator: GENERATOR, sections };
}

/** The exact bytes written to disk, so writer and test agree on formatting. */
export function serializeDocsIndex(index: DocsIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
