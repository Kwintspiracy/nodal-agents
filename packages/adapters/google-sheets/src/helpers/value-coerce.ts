// @nodal-agents/adapter-google-sheets — cell value normalization

/**
 * Normalize a raw cell value from the Sheets API.
 * - Null/undefined → empty string
 * - Numbers/booleans → as-is (the JSON already decoded them)
 * - Strings → trimmed
 *
 * Note: When using FORMATTED_VALUE render option the API returns strings.
 * When using UNFORMATTED_VALUE it returns the underlying number/boolean.
 * This helper just ensures no undefined/null leaks through.
 */
export function coerceCellValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  // Objects/arrays shouldn't appear but stringify just in case
  return String(value);
}

/**
 * Normalize a full row of cell values.
 */
export function coerceRow(row: unknown[]): Array<string | number | boolean> {
  return row.map(coerceCellValue);
}

/**
 * Normalize a 2D grid of cell values.
 */
export function coerceGrid(
  grid: unknown[][] | undefined | null,
): Array<Array<string | number | boolean>> {
  if (!grid) return [];
  return grid.map(coerceRow);
}
