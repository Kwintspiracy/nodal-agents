// @nodalai/adapter-google-sheets — batch-update helper tests

import { describe, it, expect } from 'vitest';
import {
  buildRenameSheetRequest,
  buildDeleteSheetRequest,
  buildDuplicateSheetRequest,
  buildFormatRangeRequest,
  buildResizeColumnsRequest,
  buildAutoResizeColumnsRequest,
  buildFreezeRequest,
  buildSetBasicFilterRequest,
  buildClearBasicFilterRequest,
  buildSortRangeRequest,
} from '../../helpers/batch-update.js';

describe('buildRenameSheetRequest', () => {
  it('builds correct updateSheetProperties request', () => {
    const req = buildRenameSheetRequest(123, 'New Name');
    expect(req.updateSheetProperties?.properties?.sheetId).toBe(123);
    expect(req.updateSheetProperties?.properties?.title).toBe('New Name');
    expect(req.updateSheetProperties?.fields).toBe('title');
  });
});

describe('buildDeleteSheetRequest', () => {
  it('builds correct deleteSheet request', () => {
    const req = buildDeleteSheetRequest(456);
    expect(req.deleteSheet?.sheetId).toBe(456);
  });
});

describe('buildDuplicateSheetRequest', () => {
  it('builds request with new sheet name', () => {
    const req = buildDuplicateSheetRequest(1, 2, 'Copy of Sheet1');
    expect(req.duplicateSheet?.sourceSheetId).toBe(1);
    expect(req.duplicateSheet?.insertSheetIndex).toBe(2);
    expect(req.duplicateSheet?.newSheetName).toBe('Copy of Sheet1');
  });

  it('builds request without new sheet name', () => {
    const req = buildDuplicateSheetRequest(1, 2);
    expect(req.duplicateSheet?.sourceSheetId).toBe(1);
    expect(req.duplicateSheet?.newSheetName).toBeUndefined();
  });
});

describe('buildFormatRangeRequest', () => {
  it('builds repeatCell request with correct range and fields', () => {
    const format = { textFormat: { bold: true } };
    const req = buildFormatRangeRequest(0, 0, 1, 0, 3, format, 'textFormat.bold');
    expect(req.repeatCell?.range?.sheetId).toBe(0);
    expect(req.repeatCell?.range?.startRowIndex).toBe(0);
    expect(req.repeatCell?.range?.endRowIndex).toBe(1);
    expect(req.repeatCell?.range?.startColumnIndex).toBe(0);
    expect(req.repeatCell?.range?.endColumnIndex).toBe(3);
    expect(req.repeatCell?.fields).toBe('userEnteredFormat(textFormat.bold)');
    expect(req.repeatCell?.cell?.userEnteredFormat).toEqual(format);
  });
});

describe('buildResizeColumnsRequest', () => {
  it('builds updateDimensionProperties request', () => {
    const req = buildResizeColumnsRequest(0, 0, 3, 150);
    expect(req.updateDimensionProperties?.range?.sheetId).toBe(0);
    expect(req.updateDimensionProperties?.range?.dimension).toBe('COLUMNS');
    expect(req.updateDimensionProperties?.properties?.pixelSize).toBe(150);
  });
});

describe('buildAutoResizeColumnsRequest', () => {
  it('builds autoResizeDimensions request', () => {
    const req = buildAutoResizeColumnsRequest(1, 0, 5);
    expect(req.autoResizeDimensions?.dimensions?.sheetId).toBe(1);
    expect(req.autoResizeDimensions?.dimensions?.dimension).toBe('COLUMNS');
    expect(req.autoResizeDimensions?.dimensions?.startIndex).toBe(0);
    expect(req.autoResizeDimensions?.dimensions?.endIndex).toBe(5);
  });
});

describe('buildFreezeRequest', () => {
  it('builds updateSheetProperties request for freeze', () => {
    const req = buildFreezeRequest(0, 1, 2);
    expect(req.updateSheetProperties?.properties?.sheetId).toBe(0);
    expect(req.updateSheetProperties?.properties?.gridProperties?.frozenRowCount).toBe(1);
    expect(req.updateSheetProperties?.properties?.gridProperties?.frozenColumnCount).toBe(2);
    expect(req.updateSheetProperties?.fields).toContain('frozenRowCount');
    expect(req.updateSheetProperties?.fields).toContain('frozenColumnCount');
  });
});

describe('buildSetBasicFilterRequest', () => {
  it('builds setBasicFilter request', () => {
    const req = buildSetBasicFilterRequest(0, 0, 100, 0, 5);
    expect(req.setBasicFilter?.filter?.range?.sheetId).toBe(0);
    expect(req.setBasicFilter?.filter?.range?.startRowIndex).toBe(0);
    expect(req.setBasicFilter?.filter?.range?.endRowIndex).toBe(100);
    expect(req.setBasicFilter?.filter?.range?.startColumnIndex).toBe(0);
    expect(req.setBasicFilter?.filter?.range?.endColumnIndex).toBe(5);
  });
});

describe('buildClearBasicFilterRequest', () => {
  it('builds clearBasicFilter request', () => {
    const req = buildClearBasicFilterRequest(42);
    expect(req.clearBasicFilter?.sheetId).toBe(42);
  });
});

describe('buildSortRangeRequest', () => {
  it('builds sortRange request with specs', () => {
    const specs = [{ dimensionIndex: 2, sortOrder: 'DESCENDING' as const }];
    const req = buildSortRangeRequest(0, 1, 100, 0, 5, specs);
    expect(req.sortRange?.range?.sheetId).toBe(0);
    expect(req.sortRange?.sortSpecs).toHaveLength(1);
    expect(req.sortRange?.sortSpecs?.[0]?.dimensionIndex).toBe(2);
    expect(req.sortRange?.sortSpecs?.[0]?.sortOrder).toBe('DESCENDING');
  });
});
