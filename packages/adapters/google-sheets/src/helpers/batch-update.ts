// @nodal-agents/adapter-google-sheets — batchUpdate request body builders

import type { sheets_v4 } from 'googleapis';

/**
 * Build an updateSheetProperties request to rename a sheet tab.
 */
export function buildRenameSheetRequest(
  sheetId: number,
  newTitle: string,
): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: { sheetId, title: newTitle },
      fields: 'title',
    },
  };
}

/**
 * Build a deleteSheet request.
 */
export function buildDeleteSheetRequest(sheetId: number): sheets_v4.Schema$Request {
  return { deleteSheet: { sheetId } };
}

/**
 * Build a duplicateSheet request.
 */
export function buildDuplicateSheetRequest(
  sourceSheetId: number,
  insertSheetIndex: number,
  newSheetName?: string,
): sheets_v4.Schema$Request {
  return {
    duplicateSheet: {
      sourceSheetId,
      insertSheetIndex,
      ...(newSheetName !== undefined && { newSheetName }),
    },
  };
}

/**
 * Build a repeatCell request for basic formatting.
 * Caller builds the CellFormat object; this wraps it in the request shape.
 */
export function buildFormatRangeRequest(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
  format: sheets_v4.Schema$CellFormat,
  fields: string,
): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex,
        endColumnIndex,
      },
      cell: { userEnteredFormat: format },
      fields: `userEnteredFormat(${fields})`,
    },
  };
}

/**
 * Build an updateDimensionProperties request to resize columns.
 */
export function buildResizeColumnsRequest(
  sheetId: number,
  startIndex: number,
  endIndex: number,
  pixelSize: number,
): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex,
        endIndex,
      },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  };
}

/**
 * Build an autoResizeDimensions request for columns.
 */
export function buildAutoResizeColumnsRequest(
  sheetId: number,
  startIndex: number,
  endIndex: number,
): sheets_v4.Schema$Request {
  return {
    autoResizeDimensions: {
      dimensions: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex,
        endIndex,
      },
    },
  };
}

/**
 * Build an updateSheetProperties request to freeze rows/columns.
 */
export function buildFreezeRequest(
  sheetId: number,
  frozenRowCount: number,
  frozenColumnCount: number,
): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount, frozenColumnCount },
      },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  };
}

/**
 * Build a setBasicFilter request.
 */
export function buildSetBasicFilterRequest(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): sheets_v4.Schema$Request {
  return {
    setBasicFilter: {
      filter: {
        range: {
          sheetId,
          startRowIndex,
          endRowIndex,
          startColumnIndex,
          endColumnIndex,
        },
      },
    },
  };
}

/**
 * Build a clearBasicFilter request.
 */
export function buildClearBasicFilterRequest(sheetId: number): sheets_v4.Schema$Request {
  return { clearBasicFilter: { sheetId } };
}

/**
 * Build a sortRange request. sortSpecs is an array of { dimensionIndex, sortOrder }.
 */
export function buildSortRangeRequest(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
  sortSpecs: Array<{ dimensionIndex: number; sortOrder: 'ASCENDING' | 'DESCENDING' }>,
): sheets_v4.Schema$Request {
  return {
    sortRange: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex,
        endColumnIndex,
      },
      sortSpecs,
    },
  };
}
