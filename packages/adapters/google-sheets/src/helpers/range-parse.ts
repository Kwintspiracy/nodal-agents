// @nodalai/adapter-google-sheets — A1 notation range parser

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
