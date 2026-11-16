// pdf-facts.test.ts — les pages et le format, lus dans un PDF (#1082).

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { paperOf, readPdfFacts } from '../pdf-facts';

const MM = 72 / 25.4;

async function pdfOf(sizesMm: Array<[number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h] of sizesMm) doc.addPage([w * MM, h * MM]);
  return doc.save();
}

describe('readPdfFacts @cap:travailler-sur-des-fichiers/moteur', () => {
  it('counts the pages and names the paper of the first one', async () => {
    const facts = await readPdfFacts(
      await pdfOf([
        [210, 297],
        [210, 297],
        [210, 297],
      ]),
    );
    expect(facts).toEqual({
      pages: 3,
      paper: { name: 'A4', orientation: 'portrait', width_mm: 210, height_mm: 297 },
      mixedSizes: false,
    });
  });

  it('says when the pages do not all have the same size', async () => {
    const facts = await readPdfFacts(
      await pdfOf([
        [210, 297],
        [297, 210],
      ]),
    );
    expect(facts.mixedSizes).toBe(true);
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(readPdfFacts(new TextEncoder().encode('not a pdf'))).rejects.toThrow();
  });
});

describe('paperOf', () => {
  it.each([
    [210, 297, 'A4', 'portrait'],
    [297, 210, 'A4', 'landscape'],
    [148, 210, 'A5', 'portrait'],
    [215.9, 279.4, 'Letter', 'portrait'],
    [279.4, 215.9, 'Letter', 'landscape'],
    [100, 150, null, 'portrait'],
  ] as const)('%s × %s mm is %s %s', (w, h, name, orientation) => {
    expect(paperOf(w * MM, h * MM)).toMatchObject({ name, orientation });
  });
});
