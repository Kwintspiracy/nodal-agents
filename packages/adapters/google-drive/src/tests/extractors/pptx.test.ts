// @nodalai/adapter-google-drive — PPTX extractor tests

import { describe, it, expect } from 'vitest';
import { extractPptxText } from '../../extractors/pptx';
import { DriveAdapterError } from '../../errors';

describe('extractPptxText', () => {
  it('throws DriveAdapterError with code drive_pptx_extraction_unsupported', () => {
    const buf = Buffer.from('fake pptx content');

    expect(() => extractPptxText(buf)).toThrow(DriveAdapterError);
    expect(() => extractPptxText(buf)).toThrow(
      expect.objectContaining({ code: 'drive_pptx_extraction_unsupported' }),
    );
  });

  it('never returns a value — always throws', () => {
    const buf = Buffer.alloc(0);
    let threw = false;
    try {
      extractPptxText(buf);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('thrown error has a non-empty message', () => {
    try {
      extractPptxText(Buffer.from(''));
    } catch (err) {
      expect((err as DriveAdapterError).message.length).toBeGreaterThan(0);
    }
  });
});
