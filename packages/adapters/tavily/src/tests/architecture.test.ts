// @nodalai/adapter-tavily — architecture invariant tests
// Invariant 1: No agent slugs (ender, pavel, boris, etc.) hardcoded in src/
// Invariant 6: No per-user values (UUIDs, hardcoded API keys) in src/

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const srcDir = join(__filename, '..', '..'); // packages/adapters/tavily/src

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

    // Check for strings that look like real UUIDs hardcoded as literals
    const uuidRegex = /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/gi;
    const matches = source.match(uuidRegex) ?? [];

    expect(matches, `Found hardcoded UUIDs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded Tavily API keys (tvly-...) in source files', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    // Real Tavily API keys start with "tvly-" followed by alphanumeric chars
    const apiKeyRegex = /['"`]tvly-[A-Za-z0-9]{10,}['"`]/g;
    const matches = source.match(apiKeyRegex) ?? [];

    expect(matches, `Found hardcoded API keys: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no AUTH_FAILED or hardcoded user-facing error strings', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    expect(source).not.toContain('[AUTH_FAILED]');
    expect(source).not.toContain('Re-authenticate in the dashboard');
    expect(source).not.toContain('Tavily connector is not authenticated');
  });

  it('no direct imports from @nodalai/db, @nodalai/llm, @nodalai/auth, @nodalai/memory', async () => {
    const files = await collectSourceFiles(srcDir);
    const source = await readAll(files);

    const forbidden = ['@nodalai/db', '@nodalai/llm', '@nodalai/auth', '@nodalai/memory'];
    const found: string[] = [];

    for (const pkg of forbidden) {
      if (source.includes(`from '${pkg}'`) || source.includes(`from "${pkg}"`)) {
        found.push(pkg);
      }
    }

    expect(found, `Forbidden imports found: ${found.join(', ')}`).toHaveLength(0);
  });
});
