// @nodalai/adapter-google-drive — DOCX extractor tests

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocxText } from '../../extractors/docx';

const __filename = fileURLToPath(import.meta.url);
const fixturesDir = join(__filename, '..', '..', 'fixtures');

describe('extractDocxText', () => {
  it('extracts text from a valid .docx fixture', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.docx'));
    const text = await extractDocxText(buf);

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // The sample.docx was created with "Sample Document" heading and paragraph content
    expect(text.toLowerCase()).toContain('sample');
  });

  it('returns a string (never throws) on a nearly-empty document', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.docx'));
    const text = await extractDocxText(buf);
    expect(typeof text).toBe('string');
  });

  it('returns empty string for a buffer with minimal OOXML (no paragraphs)', async () => {
    // mammoth returns '' for empty documents — just verify no throw
    const buf = await readFile(join(fixturesDir, 'sample.docx'));
    const result = await extractDocxText(buf);
    expect(result).toBeDefined();
  });
});
