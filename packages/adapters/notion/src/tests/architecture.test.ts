// @nodal-agents/adapter-notion — architecture invariant tests
// Invariant 1: No agent slugs (ender, pavel, boris, etc.) hardcoded in src/
// Invariant 6: No per-user values (UUIDs, page URLs, hardcoded IDs) in src/

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const srcDir = join(__filename, '..', '..'); // packages/adapters/notion/src

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
      // Case-insensitive word boundary match (skip if in comments — but we check all)
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

    // Notion UUIDs are 32 hex chars with optional dashes, e.g.:
    // 1234567890abcdef1234567890abcdef or 12345678-90ab-cdef-1234-567890abcdef
    // We check for strings that look like real UUIDs hardcoded as literals
    const uuidRegex = /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/gi;
    const matches = source.match(uuidRegex) ?? [];

    expect(matches, `Found hardcoded UUIDs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded notion.so page URLs in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Real page URLs like https://www.notion.so/My-Page-1234abcd...
    // Test fixture URLs (in tests/) are excluded (we only scan src/ non-test files)
    const urlRegex = /https:\/\/www\.notion\.so\/[a-zA-Z0-9-]{10,}/g;
    const matches = source.match(urlRegex) ?? [];

    expect(matches, `Found hardcoded notion.so URLs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no AUTH_FAILED or hardcoded user-facing error strings', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // The Python adapter returned strings like "[AUTH_FAILED] ..."
    // In the TypeScript adapter, errors are typed codes, never injected strings
    expect(source).not.toContain('[AUTH_FAILED]');
    expect(source).not.toContain('Re-authenticate in the dashboard');
    expect(source).not.toContain('Notion connector is not authenticated');
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
});
