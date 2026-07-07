// @nodal-agents/adapter-google-sheets — range parser tests

import { describe, it, expect } from 'vitest';
import { parseRange, buildRange, estimateRowSpan } from '../../helpers/range-parse';
import { SheetsAdapterError } from '../../errors';

describe('parseRange', () => {
  it('parses Sheet1!A1:C10', () => {
    const result = parseRange('Sheet1!A1:C10');
    expect(result.sheetName).toBe('Sheet1');
    expect(result.cellRange).toBe('A1:C10');
    expect(result.canonical).toBe('Sheet1!A1:C10');
  });

  it("parses 'Sheet with spaces'!A1", () => {
    const result = parseRange("'Sheet with spaces'!A1");
    expect(result.sheetName).toBe('Sheet with spaces');
    expect(result.cellRange).toBe('A1');
    // Canonical should re-quote it
    expect(result.canonical).toBe("'Sheet with spaces'!A1");
  });

  it('parses A1:C10 (no sheet name)', () => {
    const result = parseRange('A1:C10');
    expect(result.sheetName).toBeUndefined();
    expect(result.cellRange).toBe('A1:C10');
    expect(result.canonical).toBe('A1:C10');
  });

  it('parses full column A:A', () => {
    const result = parseRange('A:A');
    expect(result.sheetName).toBeUndefined();
    expect(result.cellRange).toBe('A:A');
  });

  it('parses full row 1:1', () => {
    const result = parseRange('1:1');
    expect(result.sheetName).toBeUndefined();
    expect(result.cellRange).toBe('1:1');
  });

  it('quotes sheet name with spaces in canonical', () => {
    const result = parseRange("'My Sheet'!B2:D5");
    expect(result.sheetName).toBe('My Sheet');
    expect(result.canonical).toBe("'My Sheet'!B2:D5");
  });

  it('throws sheets_invalid_range for empty string', () => {
    expect(() => parseRange('')).toThrow(SheetsAdapterError);
    expect(() => parseRange('')).toThrow(expect.objectContaining({ code: 'sheets_invalid_range' }));
  });

  it('throws sheets_invalid_range for invalid cell range chars', () => {
    expect(() => parseRange('Sheet1!A 1:C10')).toThrow(
      expect.objectContaining({ code: 'sheets_invalid_range' }),
    );
  });

  it('handles simple sheet name without special chars', () => {
    const result = parseRange('Data!A1:Z100');
    expect(result.sheetName).toBe('Data');
    expect(result.cellRange).toBe('A1:Z100');
    expect(result.canonical).toBe('Data!A1:Z100');
  });
});

// audit#2026-07-07 F10: estimateRowSpan lets values.ts reject an obviously
// oversized EXPLICIT range before calling the Sheets API.
describe('estimateRowSpan', () => {
  it('computes the span for an explicit bounded range', () => {
    expect(estimateRowSpan('A1:C10')).toBe(10);
    expect(estimateRowSpan('A5:C5')).toBe(1);
  });

  it('computes the span for a single cell', () => {
    expect(estimateRowSpan('A1')).toBe(1);
  });

  it('computes the span for an explicit full-row range with row numbers', () => {
    expect(estimateRowSpan('1:1')).toBe(1);
    expect(estimateRowSpan('5:50000')).toBe(49996);
  });

  it('returns a huge span for an obviously oversized explicit range', () => {
    expect(estimateRowSpan('A1:A50000000')).toBe(50000000);
  });

  it('returns null for an open-ended full-column range (no row numbers)', () => {
    expect(estimateRowSpan('A:A')).toBeNull();
    expect(estimateRowSpan('A:ZZ')).toBeNull();
  });

  it('returns null for a bare column reference', () => {
    expect(estimateRowSpan('A')).toBeNull();
  });
});

describe('buildRange', () => {
  it('builds range without sheet name', () => {
    expect(buildRange(undefined, 'A1:C10')).toBe('A1:C10');
  });

  it('builds range with simple sheet name', () => {
    expect(buildRange('Sheet1', 'A1:C10')).toBe('Sheet1!A1:C10');
  });

  it('quotes sheet names with spaces', () => {
    expect(buildRange('My Data', 'A1:C10')).toBe("'My Data'!A1:C10");
  });
});
