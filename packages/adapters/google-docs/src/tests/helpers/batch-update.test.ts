// @nodal-agents/adapter-google-docs — batch-update helper tests

import { describe, it, expect } from 'vitest';
import {
  buildInsertTextRequest,
  buildAppendTextRequest,
  buildReplaceAllTextRequest,
  buildDeleteContentRangeRequest,
  buildInsertParagraphRequest,
  buildApplyNamedStyleRequest,
  buildInsertPageBreakRequest,
  buildInsertTableRequest,
  buildInsertImageRequest,
  buildUpdateTextStyleRequest,
} from '../../helpers/batch-update';

describe('buildInsertTextRequest', () => {
  it('builds correct insertText request with index location', () => {
    const req = buildInsertTextRequest('Hello world', 5);
    expect(req.insertText?.location?.index).toBe(5);
    expect(req.insertText?.text).toBe('Hello world');
    expect(req.insertText?.endOfSegmentLocation).toBeUndefined();
  });
});

describe('buildAppendTextRequest', () => {
  it('builds insertText with endOfSegmentLocation', () => {
    const req = buildAppendTextRequest('Appended text');
    expect(req.insertText?.endOfSegmentLocation?.segmentId).toBe('');
    expect(req.insertText?.text).toBe('Appended text');
    expect(req.insertText?.location).toBeUndefined();
  });
});

describe('buildReplaceAllTextRequest', () => {
  it('builds replaceAllText with match case true', () => {
    const req = buildReplaceAllTextRequest('foo', 'bar', true);
    expect(req.replaceAllText?.containsText?.text).toBe('foo');
    expect(req.replaceAllText?.containsText?.matchCase).toBe(true);
    expect(req.replaceAllText?.replaceText).toBe('bar');
  });

  it('builds replaceAllText with match case false', () => {
    const req = buildReplaceAllTextRequest('FOO', 'baz', false);
    expect(req.replaceAllText?.containsText?.matchCase).toBe(false);
  });
});

describe('buildDeleteContentRangeRequest', () => {
  it('builds deleteContentRange with correct indices', () => {
    const req = buildDeleteContentRangeRequest(10, 25);
    expect(req.deleteContentRange?.range?.startIndex).toBe(10);
    expect(req.deleteContentRange?.range?.endIndex).toBe(25);
  });
});

describe('buildInsertParagraphRequest', () => {
  it('appends newline if not present', () => {
    const req = buildInsertParagraphRequest(1, 'Hello');
    expect(req.insertText?.text).toBe('Hello\n');
    expect(req.insertText?.location?.index).toBe(1);
  });

  it('preserves existing trailing newline', () => {
    const req = buildInsertParagraphRequest(1, 'Hello\n');
    expect(req.insertText?.text).toBe('Hello\n');
  });
});

describe('buildApplyNamedStyleRequest', () => {
  it('builds updateParagraphStyle request', () => {
    const req = buildApplyNamedStyleRequest(1, 10, 'HEADING_1');
    expect(req.updateParagraphStyle?.range?.startIndex).toBe(1);
    expect(req.updateParagraphStyle?.range?.endIndex).toBe(10);
    expect(req.updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe('HEADING_1');
    expect(req.updateParagraphStyle?.fields).toBe('namedStyleType');
  });

  it('works for all heading levels', () => {
    for (let i = 1; i <= 6; i++) {
      const req = buildApplyNamedStyleRequest(1, 10, `HEADING_${i}`);
      expect(req.updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe(`HEADING_${i}`);
    }
  });

  it('works for NORMAL_TEXT, TITLE, SUBTITLE', () => {
    for (const style of ['NORMAL_TEXT', 'TITLE', 'SUBTITLE']) {
      const req = buildApplyNamedStyleRequest(1, 10, style);
      expect(req.updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe(style);
    }
  });
});

describe('buildInsertPageBreakRequest', () => {
  it('builds insertPageBreak request at index', () => {
    const req = buildInsertPageBreakRequest(42);
    expect(req.insertPageBreak?.location?.index).toBe(42);
  });
});

describe('buildInsertTableRequest', () => {
  it('builds insertTable request with correct dimensions', () => {
    const req = buildInsertTableRequest(5, 3, 4);
    expect(req.insertTable?.location?.index).toBe(5);
    expect(req.insertTable?.rows).toBe(3);
    expect(req.insertTable?.columns).toBe(4);
  });
});

describe('buildInsertImageRequest', () => {
  it('builds insertInlineImage request without size', () => {
    const req = buildInsertImageRequest(10, 'https://example.com/img.png');
    expect(req.insertInlineImage?.location?.index).toBe(10);
    expect(req.insertInlineImage?.uri).toBe('https://example.com/img.png');
    expect(req.insertInlineImage?.objectSize).toBeUndefined();
  });

  it('builds insertInlineImage request with width and height', () => {
    const req = buildInsertImageRequest(10, 'https://example.com/img.png', 200, 150);
    expect(req.insertInlineImage?.objectSize?.width?.magnitude).toBe(200);
    expect(req.insertInlineImage?.objectSize?.width?.unit).toBe('PT');
    expect(req.insertInlineImage?.objectSize?.height?.magnitude).toBe(150);
    expect(req.insertInlineImage?.objectSize?.height?.unit).toBe('PT');
  });

  it('builds insertInlineImage request with width only', () => {
    const req = buildInsertImageRequest(10, 'https://example.com/img.png', 100);
    expect(req.insertInlineImage?.objectSize?.width?.magnitude).toBe(100);
    expect(req.insertInlineImage?.objectSize?.height).toBeUndefined();
  });
});

describe('buildUpdateTextStyleRequest', () => {
  it('builds updateTextStyle request with bold', () => {
    const req = buildUpdateTextStyleRequest(5, 15, { bold: true }, 'bold');
    expect(req.updateTextStyle?.range?.startIndex).toBe(5);
    expect(req.updateTextStyle?.range?.endIndex).toBe(15);
    expect(req.updateTextStyle?.textStyle?.bold).toBe(true);
    expect(req.updateTextStyle?.fields).toBe('bold');
  });

  it('builds updateTextStyle request with multiple fields', () => {
    const req = buildUpdateTextStyleRequest(1, 20, { bold: true, italic: true }, 'bold,italic');
    expect(req.updateTextStyle?.textStyle?.bold).toBe(true);
    expect(req.updateTextStyle?.textStyle?.italic).toBe(true);
    expect(req.updateTextStyle?.fields).toBe('bold,italic');
  });

  it('builds updateTextStyle request with font size', () => {
    const req = buildUpdateTextStyleRequest(
      1,
      10,
      { fontSize: { magnitude: 14, unit: 'PT' } },
      'fontSize',
    );
    expect(req.updateTextStyle?.textStyle?.fontSize?.magnitude).toBe(14);
    expect(req.updateTextStyle?.textStyle?.fontSize?.unit).toBe('PT');
  });
});
