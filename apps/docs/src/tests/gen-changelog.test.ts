/**
 * gen-changelog.test.ts — issue #405.
 *
 * The docs changelog page stopped at 0.9.0 while the root CHANGELOG.md carried
 * 0.9.1: two copies of the same list, and the second one forgotten. The page is
 * now generated from the root file. What these tests prove, on the file the
 * script actually wrote: every release heading of the root is on the page, in
 * the same order, newest first; nothing of the root's own header leaks in; and
 * a `<placeholder>` outside code is escaped so the MDX pipeline keeps it as
 * text.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

let outRoot: string;
let page: string;
let root: string;

beforeAll(async () => {
  outRoot = mkdtempSync(join(tmpdir(), 'nodal-gen-changelog-'));
  process.env.NODAL_DOCS_GEN_OUT = outRoot;
  // Top-level script: importing it runs it, against the directory named above.
  await import('../../scripts/gen-changelog');
  page = readFileSync(join(outRoot, 'content', 'docs', 'changelog.md'), 'utf8');
  root = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
});

afterAll(() => {
  delete process.env.NODAL_DOCS_GEN_OUT;
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

const headings = (md: string): string[] => md.match(/^## v.*$/gm) ?? [];

describe('the docs changelog page is the root CHANGELOG.md, generated', () => {
  it('carries every release heading of the root, in the same order, newest first', () => {
    const fromRoot = headings(root);
    expect(fromRoot.length).toBeGreaterThan(10);
    expect(headings(page)).toEqual(fromRoot);
    // The newest release is the root's newest, never one behind (the #405 symptom).
    expect(headings(page)[0]).toBe(fromRoot[0]);
  });

  it('starts with the page frontmatter, not the root title', () => {
    expect(page.startsWith('---\ntitle: Changelog\n')).toBe(true);
    expect(page).not.toContain('# Changelog\n');
    expect(page).not.toContain('nodal-agents update   # upgrade in place');
  });

  it('escapes an angle-bracket placeholder outside code, and leaves code spans alone', () => {
    // The root says «unreachable at <time>» in prose (v0.8.x): as text, not a tag.
    if (/<time>/.test(root.replace(/`[^`\n]*`/g, ''))) {
      expect(page).toContain('&lt;time>');
      expect(page).not.toMatch(/[^&]<time>/);
    }
    // A code span keeps its brackets.
    expect(page).toContain('`nodal-agents update`');
  });
});
