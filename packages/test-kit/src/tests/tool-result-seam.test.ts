// tool-result-seam.test.ts — the tool-result seam scanner, proved on a temporary tree:
// a tool run beside executeTool and a tool row written beside the seam are found,
// in the forms a formatter writes them; a database query, a row through the seam,
// a mark without output and a named exemption are not.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scanForToolResultBypass } from '../tool-result-seam';
import { mkdtempSourceTree } from '../source-files';

let dir: string;

const write = (rel: string, text: string): void => {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(() => {
  dir = mkdtempSourceTree('tool-seam-');
  // A tool run directly: its result would reach the caller unmasked.
  write('raw-run.ts', 'const out = await tool.execute(input, ctx);\n');
  write(
    'raw-run-multiline.ts',
    'const out = await def\n  .execute(\n    { query },\n    { jobId: "", db },\n  );\n',
  );
  // A database query is not a tool run.
  write('query.ts', 'await db.execute(sql`SELECT 1, 2`);\nawait tx.execute(sql`x`);\n');
  // A tool row written with an output of its own.
  write(
    'raw-row.ts',
    'await db\n  .insert(toolCalls)\n  .values({ jobId, toolName: "x", toolOutput: redactSecretsInText(out) });\n',
  );
  write('raw-update.ts', 'await db.update(toolCalls).set({ toolOutput: output }).where(w);\n');
  // Through the seam's function, a mark without output, a row built by the seam's module.
  write(
    'seam-row.ts',
    'await db.insert(toolCalls).values({ toolOutput: maskToolResultText(o, p, k).slice(0, 9) });\n',
  );
  write('mark.ts', 'await db.insert(toolCalls).values({ toolName: "x", toolOutput: null });\n');
  // A row built by a builder it spreads: the builder's own `toolOutput:` argument is its input.
  write(
    'spread.ts',
    'await db.insert(toolCalls).values({ entityId, ...buildCliAuditRow({ toolOutput: evt.output }) });\n',
  );
  // A named exemption.
  write('exempt.ts', 'const r = await searchTool.execute({ query }, ctx);\n');
  // The seam itself, named by the caller.
  write('seam.ts', 'output = await tool.execute(validatedInput, execCtx);\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the tool-result seam scanner @cap:connecter-un-service/moteur', () => {
  it('finds every run and every row beside the seam, and nothing else', () => {
    const found = scanForToolResultBypass({
      srcDir: dir,
      skipFiles: ['seam.ts'],
      exemptRuns: [{ line: 'searchTool.execute(', reason: 'inside web_search' }],
    });
    const byFile = found.map((v) => `${basename(v.file)}:${v.rule}`).sort();
    expect(byFile).toEqual([
      'raw-row.ts:tool-row-beside-the-seam',
      'raw-run-multiline.ts:tool-run-beside-execute-tool',
      'raw-run.ts:tool-run-beside-execute-tool',
      'raw-update.ts:tool-row-beside-the-seam',
    ]);
  });
});
