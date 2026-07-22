// @nodal-agents/adapter-outlook-mail — architecture invariant tests
// Invariant 1: No agent slugs (ender, pavel, boris, etc.) hardcoded in src/
// Invariant 6: No per-user values (UUIDs, folder URLs, hardcoded IDs) in src/
// Invariant 7: Official SDK only (@microsoft/microsoft-graph-client)

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const srcDir = join(__filename, '..', '..'); // packages/adapters/outlook-mail/src

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

    const agentSlugs = ['ender', 'pavel', 'boris', 'kwint'];
    const found: string[] = [];
    for (const slug of agentSlugs) {
      const regex = new RegExp(`\\b${slug}\\b`, 'i');
      if (regex.test(source)) found.push(slug);
    }
    expect(found, `Found agent slugs in src: ${found.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded UUIDs (per-user values) in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    const uuidRegex = /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/gi;
    const matches = source.match(uuidRegex) ?? [];
    expect(matches, `Found hardcoded UUIDs: ${matches.join(', ')}`).toHaveLength(0);
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
      if (source.includes(`from '${pkg}'`) || source.includes(`from "${pkg}"`)) found.push(pkg);
    }
    expect(found, `Forbidden imports found: ${found.join(', ')}`).toHaveLength(0);
  });

  it('uses the official @microsoft/microsoft-graph-client SDK — no hand-rolled fetch wrapping', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    expect(source).toContain("from '@microsoft/microsoft-graph-client'");
    // Should NOT have manual fetch calls to Graph or the Microsoft identity endpoint.
    expect(source).not.toContain('https://graph.microsoft.com');
    expect(source).not.toContain('login.microsoftonline.com');
    expect(source).not.toMatch(/\bfetch\(\s*['"`]https:\/\/graph\.microsoft\.com/);
  });

  it('no hardcoded email addresses in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    const emailRegex = /['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"`]/g;
    const matches = (source.match(emailRegex) ?? []).filter(
      (m) => !m.includes('example.com') && !m.includes('test.com'),
    );
    expect(matches, `Found hardcoded email addresses: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded user-facing error strings (typed error codes only)', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    expect(source).not.toContain('[AUTH_FAILED]');
    expect(source).not.toContain('Re-authenticate in the dashboard');
    expect(source).not.toContain('Outlook connector is not authenticated');
  });
});
