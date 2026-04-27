// @nodalai/adapter-google-drive — PDF extractor tests

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../../extractors/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const fixturesDir = join(__filename, '..', '..', 'fixtures');

describe('extractPdfText', () => {
  it('extracts text from a valid .pdf fixture', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.pdf'));
    const text = await extractPdfText(buf);

    expect(typeof text).toBe('string');
    // The sample.pdf fixture is a real-world PDF — just assert non-empty text was extracted.
    expect(text.length).toBeGreaterThan(0);
  });

  it('returns a string result', async () => {
    const buf = await readFile(join(fixturesDir, 'sample.pdf'));
    const text = await extractPdfText(buf);
    expect(typeof text).toBe('string');
  });
});
