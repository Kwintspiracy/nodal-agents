// @nodal-agents/adapter-google-sheets — A1 notation range parser

import { SheetsAdapterError } from '../errors';

export interface ParsedRange {
  /** The sheet name, unquoted. Undefined if no sheet name prefix was given. */
  sheetName: string | undefined;
  /** The cell range portion, e.g. 'A1:C10' or 'A:A'. */
  cellRange: string;
  /** The full canonical range string with sheet name quoted if needed. */
  canonical: string;
}

/**
 * Parse an A1-notation range string.
 *
 * Supported formats:
 *   - 'Sheet1!A1:C10'          → sheetName='Sheet1', cellRange='A1:C10'
 *   - "'Sheet with spaces'!A1" → sheetName='Sheet with spaces', cellRange='A1'
 *   - 'A1:C10'                 → sheetName=undefined, cellRange='A1:C10'
 *   - 'A:A'                    → sheetName=undefined, cellRange='A:A'
 *
 * Throws sheets_invalid_range for clearly malformed input.
 */
export function parseRange(range: string): ParsedRange {
  const trimmed = range.trim();
  if (!trimmed) {
    throw new SheetsAdapterError('sheets_invalid_range', `Empty range string`);
  }

  let sheetName: string | undefined;
  let cellRange: string;

  // Detect sheet!range separator
  const bangIdx = trimmed.indexOf('!');
  if (bangIdx !== -1) {
    let rawSheet = trimmed.slice(0, bangIdx);
    cellRange = trimmed.slice(bangIdx + 1);

    // Strip surrounding single quotes from sheet name
    if (rawSheet.startsWith("'") && rawSheet.endsWith("'")) {
      rawSheet = rawSheet.slice(1, -1).replace(/''/g, "'");
    }
    sheetName = rawSheet;
  } else {
    cellRange = trimmed;
    sheetName = undefined;
  }

  // Validate cell range: must be non-empty and match A1 pattern loosely
  // Allow: A1, A1:B2, A:A, 1:1, A, Sheet1 (bare sheet name without !)
  const cellRangeRegex = /^[A-Za-z0-9:$]+$/;
  if (!cellRange || !cellRangeRegex.test(cellRange)) {
    throw new SheetsAdapterError(
      'sheets_invalid_range',
      `Invalid cell range portion: '${cellRange}' in '${range}'`,
    );
  }

  // Build canonical form
  let canonical: string;
  if (sheetName !== undefined) {
    // Quote sheet name if it contains spaces or special chars
    const needsQuoting = /[\s!'"\\]/.test(sheetName);
    const quotedSheet = needsQuoting ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
    canonical = `${quotedSheet}!${cellRange}`;
  } else {
    canonical = cellRange;
  }

  return { sheetName, cellRange, canonical };
}

/**
 * Build a full range string from sheet name + cell range.
 * If sheetName is provided, quotes it if needed.
 */
export function buildRange(sheetName: string | undefined, cellRange: string): string {
  if (!sheetName) return cellRange;
  const needsQuoting = /[\s!'"\\]/.test(sheetName);
  const quotedSheet = needsQuoting ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  return `${quotedSheet}!${cellRange}`;
}

/**
 * audit#2026-07-07 F10: ROW_CAP in values.ts was enforced AFTER `values.get`
 * had already fetched and parsed the entire range — an explicit but absurd
 * range like 'A1:A50000000' would pay the full API round-trip before being
 * rejected. This estimates the row count implied by explicit numeric row
 * bounds in the A1 cell range, so obviously-oversized EXPLICIT ranges can be
 * rejected before the call.
 *
 * Returns null when the range has NO explicit numeric row bound on one or
 * both sides (e.g. a full-column range like 'A:ZZ', or a bare column 'A') —
 * for those, the actual row count is only known by the Sheets API (which
 * only returns rows that hold data, not the sheet's theoretical row limit),
 * so we cannot bound it here. The post-fetch ROW_CAP check remains the
 * safety net for that case — callers should prefer explicit numeric ranges
 * (e.g. 'A1:D10000') for large sheets, since open-ended ranges cannot be
 * size-checked before the fetch.
 */
export function estimateRowSpan(cellRange: string): number | null {
  const parts = cellRange.split(':');
  if (parts.length > 2) return null;

  const rowOf = (part: string): number | null => {
    const m = /^\$?[A-Za-z]*\$?(\d+)$/.exec(part);
    return m?.[1] !== undefined ? Number(m[1]) : null;
  };

  const first = parts[0] ?? '';
  const second = parts[1];

  if (second === undefined) {
    // Single cell or bare column/row reference, e.g. 'A1' or 'A'.
    const row = rowOf(first);
    return row !== null ? 1 : null;
  }

  const startRow = rowOf(first);
  const endRow = rowOf(second);
  if (startRow === null || endRow === null) return null; // open-ended column/row range

  return Math.abs(endRow - startRow) + 1;
}
