// @nodal-agents/adapter-google-drive — XLSX extractor tests

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractXlsxText } from '../../extractors/xlsx';

const __filename = fileURLToPath(import.meta.url);
const fixturesDir = join(__filename, '..', '..', 'fixtures');

describe('extractXlsxText', () => {
  it('extracts sheet content from a valid .xlsx fixture', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.xlsx'));
    const text = await extractXlsxText(buf);

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // sample.xlsx has Sheet1 with rows: Name/Age/City, Alice/30/Paris, Bob/25/Lyon
    expect(text).toContain('Sheet1');
    expect(text).toContain('Name');
    expect(text).toContain('Alice');
  });

  it('includes sheet header separator', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.xlsx'));
    const text = await extractXlsxText(buf);
    expect(text).toContain('--- Sheet: Sheet1 ---');
  });

  it('tab-separates cell values', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.xlsx'));
    const text = await extractXlsxText(buf);
    // Rows contain tab-separated values
    expect(text).toMatch(/Name\t/);
  });

  it('returns a string result', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.xlsx'));
    const result = await extractXlsxText(buf);
    expect(typeof result).toBe('string');
  });
});
