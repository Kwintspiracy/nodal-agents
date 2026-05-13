// @nodal-agents/adapter-google-sheets — architecture invariant tests
// Invariant 1: No agent slugs (ender, pavel, boris, etc.) hardcoded in src/
// Invariant 6: No per-user values (UUIDs, spreadsheet URLs, hardcoded IDs) in src/
// Invariant 7: Official SDK only (googleapis)

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const srcDir = join(__filename, '..', '..'); // packages/adapters/google-sheets/src

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'tests') {
      files.push(...(await collectSourceFiles(fullPath)));
    } else if (entry.isFile() && (extname(entry.name) === '.ts' || extname(entry.name) === '.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readAll(files: string[]): Promise<string> {
  const contents = await Promise.all(files.map((f) => readFile(f, 'utf-8')));
  return contents.join('\n');
}

describe('architecture invariants', () => {
  it('no agent slugs hardcoded in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Known agent slugs from KwintAgents — must never appear in adapter code
    const agentSlugs = ['ender', 'pavel', 'boris', 'kwint'];
    const found: string[] = [];

    for (const slug of agentSlugs) {
      const regex = new RegExp(`\\b${slug}\\b`, 'i');
      if (regex.test(source)) {
        found.push(slug);
      }
    }

    expect(found, `Found agent slugs in src: ${found.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded UUIDs (per-user values) in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // UUID format: 8-4-4-4-12 hex chars in quotes
    const uuidRegex = /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/gi;
    const matches = source.match(uuidRegex) ?? [];

    expect(matches, `Found hardcoded UUIDs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded Google Sheets spreadsheet URLs in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Real Sheets URLs like https://docs.google.com/spreadsheets/d/1AbC...
    const urlRegex = /https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]{10,}/g;
    const matches = source.match(urlRegex) ?? [];

    expect(matches, `Found hardcoded Sheets URLs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no AUTH_FAILED or hardcoded user-facing error strings', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // The Python adapter used [AUTH_FAILED] strings — TypeScript adapter uses typed codes
    expect(source).not.toContain('[AUTH_FAILED]');
    expect(source).not.toContain('Re-authenticate in the dashboard');
    expect(source).not.toContain('Google Sheets connector is not authenticated');
  });

  it('no direct imports from @nodal-agents/db, @nodal-agents/llm, @nodal-agents/auth, @nodal-agents/memory', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    const forbidden = [
      '@nodal-agents/db',
      '@nodal-agents/llm',
      '@nodal-agents/auth',
      '@nodal-agents/memory',
    ];
    const found: string[] = [];

    for (const pkg of forbidden) {
      if (source.includes(`from '${pkg}'`) || source.includes(`from "${pkg}"`)) {
        found.push(pkg);
      }
    }

    expect(found, `Forbidden imports found: ${found.join(', ')}`).toHaveLength(0);
  });

  it('uses official googleapis SDK — no hand-rolled fetch wrapping', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Should import from 'googleapis', not hand-rolling fetch calls to googleapis.com
    expect(source).toContain("from 'googleapis'");
    // Should NOT have manual fetch calls to googleapis.com
    expect(source).not.toContain('https://www.googleapis.com');
    expect(source).not.toContain('https://oauth2.googleapis.com');
  });

  it('no hardcoded email addresses in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Email pattern in string literals — should not find any real emails
    const emailRegex = /['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"`]/g;
    const matches = (source.match(emailRegex) ?? []).filter(
      // Allow test-related placeholders used only in tests
      (m) => !m.includes('example.com') && !m.includes('test.com'),
    );

    expect(matches, `Found hardcoded email addresses: ${matches.join(', ')}`).toHaveLength(0);
  });
});
