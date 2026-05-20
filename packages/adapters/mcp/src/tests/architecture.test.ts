// @nodal-agents/adapter-mcp — architecture invariant tests.
// Adapter packages must not import db/llm/auth/memory, must carry no agent
// slugs, and must hardcode no per-user UUIDs.

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const srcDir = join(__filename, '..', '..'); // packages/adapters/mcp/src

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
    const source = await readAll(await collectSourceFiles(srcDir));
    const agentSlugs = ['ender', 'pavel', 'boris', 'kwint'];
    const found = agentSlugs.filter((slug) => new RegExp(`\\b${slug}\\b`, 'i').test(source));
    expect(found, `Found agent slugs in src: ${found.join(', ')}`).toHaveLength(0);
  });

  it('no hardcoded UUIDs (per-user values) in source files', async () => {
    const source = await readAll(await collectSourceFiles(srcDir));
    const uuidRegex = /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/gi;
    const matches = source.match(uuidRegex) ?? [];
    expect(matches, `Found hardcoded UUIDs: ${matches.join(', ')}`).toHaveLength(0);
  });

  it('no direct imports from @nodal-agents/db, /llm, /auth, /memory', async () => {
    const source = await readAll(await collectSourceFiles(srcDir));
    const forbidden = [
      '@nodal-agents/db',
      '@nodal-agents/llm',
      '@nodal-agents/auth',
      '@nodal-agents/memory',
    ];
    const found = forbidden.filter(
      (pkg) => source.includes(`from '${pkg}'`) || source.includes(`from "${pkg}"`),
    );
    expect(found, `Forbidden imports found: ${found.join(', ')}`).toHaveLength(0);
  });
});
