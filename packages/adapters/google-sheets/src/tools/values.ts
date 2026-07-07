// @nodal-agents/adapter-google-sheets — value tools
// read_range, read_all, batch_read_ranges, write_range, append_row,
// clear_range, batch_update_values, find_rows

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { sheets_v4 } from 'googleapis';
import { mapSheetsError, SheetsAdapterError } from '../errors';
import { coerceGrid } from '../helpers/value-coerce';
import { parseRange, estimateRowSpan } from '../helpers/range-parse';

/** Max rows allowed in a single read before throwing sheets_range_too_large */
const ROW_CAP = 10_000;

/**
 * audit#2026-07-07 F10: raise sheets_range_too_large BEFORE calling the Sheets
 * API when the range gives an explicit numeric row span that already exceeds
 * ROW_CAP (e.g. 'A1:A50000000') — avoids paying the full fetch+parse for an
 * obviously-oversized range. Open-ended ranges (full column, e.g. 'A:ZZ')
 * cannot be bounded this way — estimateRowSpan returns null for those, and
 * the existing post-fetch ROW_CAP check below remains the safety net.
 */
function rejectIfObviouslyTooLarge(cellRange: string, fullRange: string): void {
  const span = estimateRowSpan(cellRange);
  if (span !== null && span > ROW_CAP) {
    throw new SheetsAdapterError(
      'sheets_range_too_large',
      `Range '${fullRange}' spans ${span} rows which exceeds the ${ROW_CAP}-row cap. Use a smaller range.`,
    );
  }
}

// ── sheets_read_range ──────────────────────────────────────────────────────

const ReadRangeInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  range: z.string().describe("A1-notation range, e.g. 'Sheet1!A1:D10' or 'A:A' for a full column."),
  value_render_option: z
    .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
    .optional()
    .describe(
      'How values are rendered. FORMATTED_VALUE (default) returns display strings. ' +
        'UNFORMATTED_VALUE returns raw numbers/booleans. FORMULA returns formula strings.',
    ),
});

export type ReadRangeOutput = {
  range: string;
  rows: number;
  cols: number;
  values: Array<Array<string | number | boolean>>;
};

export function createReadRangeTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof ReadRangeInput, ReadRangeOutput> {
  return {
    name: 'sheets_read_range',
    description:
      'Read a specific A1-notation range from a Google Sheet. Returns a 2D array of cell values. ' +
      'Capped at 10,000 rows — use a smaller range if exceeded.',
    inputSchema: ReadRangeInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const parsed = parseRange(input.range); // validate syntax
        rejectIfObviouslyTooLarge(parsed.cellRange, input.range); // audit#2026-07-07 F10
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: input.spreadsheet_id,
          range: input.range,
          valueRenderOption: input.value_render_option ?? 'FORMATTED_VALUE',
        });
        const raw = res.data.values ?? [];
        if (raw.length > ROW_CAP) {
          throw new SheetsAdapterError(
            'sheets_range_too_large',
            `Range returned ${raw.length} rows which exceeds the ${ROW_CAP}-row cap. Use a smaller range.`,
          );
        }
        const values = coerceGrid(raw);
        const cols = values.reduce((max, row) => Math.max(max, row.length), 0);
        return { range: res.data.range ?? input.range, rows: values.length, cols, values };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_read_all ────────────────────────────────────────────────────────

const ReadAllInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_name: z.string().optional().describe('Sheet tab name (default: first sheet).'),
});

export type ReadAllOutput = {
  sheetName: string;
  headers: string[];
  rowCount: number;
  values: Array<Array<string | number | boolean>>;
};

export function createReadAllTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof ReadAllInput, ReadAllOutput> {
  return {
    name: 'sheets_read_all',
    // audit#2026-07-07 F10: unlike sheets_read_range, this always targets the
    // whole sheet tab — there is no explicit numeric row bound to check
    // up front (estimateRowSpan has nothing to work with), so the ROW_CAP
    // check below necessarily runs AFTER the full sheet has been fetched.
    // Prefer sheets_read_range with an explicit bounded range on large sheets.
    description:
      'Read all values from a sheet tab. Returns the full 2D array. ' +
      'Capped at 10,000 rows — use sheets_read_range for partial reads on large sheets. ' +
      'Note: because this reads a whole tab, the cap is only enforced AFTER the full sheet is ' +
      'fetched — prefer sheets_read_range with an explicit row-bounded range for very large sheets.',
    inputSchema: ReadAllInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        // Resolve sheet name: if not given, fetch metadata to get first sheet
        let sheetName = input.sheet_name;
        if (!sheetName) {
          const meta = await sheets.spreadsheets.get({
            spreadsheetId: input.spreadsheet_id,
            fields: 'sheets.properties.title',
          });
          sheetName = meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
        }

        const range = `'${sheetName.replace(/'/g, "''")}'`;
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: input.spreadsheet_id,
          range,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        const raw = res.data.values ?? [];
        if (raw.length > ROW_CAP) {
          throw new SheetsAdapterError(
            'sheets_range_too_large',
            `Sheet has ${raw.length} rows which exceeds the ${ROW_CAP}-row cap. Use sheets_read_range with a smaller range.`,
          );
        }
        const allRows = coerceGrid(raw);
        const headers = (allRows[0] ?? []).map((h) => String(h));
        const dataRows = allRows.slice(1);
        return {
          sheetName,
          headers,
          rowCount: dataRows.length,
          values: allRows,
        };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_batch_read_ranges ───────────────────────────────────────────────

const BatchReadRangesInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  ranges: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe('Array of A1-notation ranges to read in a single API call (max 50).'),
  value_render_option: z
    .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
    .optional()
    .describe('How values are rendered (default FORMATTED_VALUE).'),
});

export type BatchReadRangesOutput = {
  results: Array<{
    range: string;
    rows: number;
    cols: number;
    values: Array<Array<string | number | boolean>>;
  }>;
};

export function createBatchReadRangesTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof BatchReadRangesInput, BatchReadRangesOutput> {
  return {
    name: 'sheets_batch_read_ranges',
    description:
      'Read multiple A1-notation ranges from a spreadsheet in a single API call. ' +
      'Efficient for dashboards that need data from several tabs or ranges at once.',
    inputSchema: BatchReadRangesInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        for (const r of input.ranges) parseRange(r); // validate all
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: input.spreadsheet_id,
          ranges: input.ranges,
          valueRenderOption: input.value_render_option ?? 'FORMATTED_VALUE',
        });
        const results = (res.data.valueRanges ?? []).map((vr) => {
          const raw = vr.values ?? [];
          const values = coerceGrid(raw);
          const cols = values.reduce((max, row) => Math.max(max, row.length), 0);
          return { range: vr.range ?? '', rows: values.length, cols, values };
        });
        return { results };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_write_range ─────────────────────────────────────────────────────

const WriteRangeInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  range: z
    .string()
    .describe("A1-notation range. The top-left cell anchors the write, e.g. 'Sheet1!A1'."),
  values: z
    .array(z.array(z.unknown()))
    .describe("2D array of values to write. Example: [['Name','Score'],['Alice',95]]."),
  value_input_option: z
    .enum(['RAW', 'USER_ENTERED'])
    .optional()
    .describe(
      'RAW stores strings as-is; USER_ENTERED parses numbers/dates/formulas like a human typing (default).',
    ),
});

export type WriteRangeOutput = {
  updatedRange: string;
  updatedRows: number;
  updatedCols: number;
  updatedCells: number;
};

export function createWriteRangeTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof WriteRangeInput, WriteRangeOutput> {
  return {
    name: 'sheets_write_range',
    description:
      'Write (overwrite) a 2D array of values into a Google Sheet range. ' +
      'Existing values in the range are replaced. Use sheets_append_row to add rows at the end.',
    inputSchema: WriteRangeInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        parseRange(input.range);
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId: input.spreadsheet_id,
          range: input.range,
          valueInputOption: input.value_input_option ?? 'USER_ENTERED',
          requestBody: { values: input.values as string[][] },
        });
        return {
          updatedRange: res.data.updatedRange ?? input.range,
          updatedRows: res.data.updatedRows ?? 0,
          updatedCols: res.data.updatedColumns ?? 0,
          updatedCells: res.data.updatedCells ?? 0,
        };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_append_row ──────────────────────────────────────────────────────

const AppendRowInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  range: z
    .string()
    .describe(
      "Sheet name or range that identifies where to append, e.g. 'Sheet1' or 'Sheet1!A:Z'. " +
        'Sheets auto-detects the last row with data and appends after it.',
    ),
  values: z
    .array(z.array(z.unknown()))
    .describe(
      "2D array of rows to append. For a single row: [['Name','Score']]. For multiple: [['Alice',95],['Bob',87]].",
    ),
  value_input_option: z
    .enum(['RAW', 'USER_ENTERED'])
    .optional()
    .describe('RAW stores strings as-is; USER_ENTERED parses numbers/dates/formulas (default).'),
});

export type AppendRowOutput = {
  updatedRange: string;
  updatedRows: number;
  updatedCells: number;
};

export function createAppendRowTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof AppendRowInput, AppendRowOutput> {
  return {
    name: 'sheets_append_row',
    description:
      'Append one or more rows to the end of a Google Sheet (after the last row with data). ' +
      "Pass a 2D array — e.g. [['Alice', 95]] for one row or [['Alice',95],['Bob',87]] for multiple.",
    inputSchema: AppendRowInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: input.spreadsheet_id,
          range: input.range,
          valueInputOption: input.value_input_option ?? 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: input.values as string[][] },
        });
        const updates = res.data.updates;
        return {
          updatedRange: updates?.updatedRange ?? input.range,
          updatedRows: updates?.updatedRows ?? 0,
          updatedCells: updates?.updatedCells ?? 0,
        };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_clear_range ─────────────────────────────────────────────────────

const ClearRangeInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  range: z
    .string()
    .describe("A1-notation range to clear, e.g. 'Sheet1!A2:Z100'. Formatting is preserved."),
});

export type ClearRangeOutput = {
  clearedRange: string;
};

export function createClearRangeTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof ClearRangeInput, ClearRangeOutput> {
  return {
    name: 'sheets_clear_range',
    description:
      'Clear values from a range in a Google Sheet. Cell formatting and structure are preserved. ' +
      'To delete rows entirely, use sheets_delete_sheet and recreate, or use write with empty values.',
    inputSchema: ClearRangeInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        parseRange(input.range);
        const res = await sheets.spreadsheets.values.clear({
          spreadsheetId: input.spreadsheet_id,
          range: input.range,
        });
        return { clearedRange: res.data.clearedRange ?? input.range };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_batch_update_values ─────────────────────────────────────────────

const BatchUpdateValuesInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  updates: z
    .array(
      z.object({
        range: z.string().describe("A1-notation range, e.g. 'Sheet1!A1'."),
        values: z.array(z.array(z.unknown())).describe('2D array of values to write.'),
      }),
    )
    .min(1)
    .max(50)
    .describe('Array of range+values pairs to write in a single API call (max 50).'),
  value_input_option: z
    .enum(['RAW', 'USER_ENTERED'])
    .optional()
    .describe('RAW stores strings as-is; USER_ENTERED parses numbers/dates/formulas (default).'),
});

export type BatchUpdateValuesOutput = {
  totalUpdatedCells: number;
  totalUpdatedRows: number;
  responses: Array<{ updatedRange: string; updatedCells: number }>;
};

export function createBatchUpdateValuesTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof BatchUpdateValuesInput, BatchUpdateValuesOutput> {
  return {
    name: 'sheets_batch_update_values',
    description:
      'Write values to multiple ranges in a single API call. More efficient than calling sheets_write_range repeatedly.',
    inputSchema: BatchUpdateValuesInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        for (const u of input.updates) parseRange(u.range);
        const res = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            valueInputOption: input.value_input_option ?? 'USER_ENTERED',
            data: input.updates.map((u) => ({
              range: u.range,
              values: u.values as string[][],
            })),
          },
        });
        const responses = (res.data.responses ?? []).map((r) => ({
          updatedRange: r.updatedRange ?? '',
          updatedCells: r.updatedCells ?? 0,
        }));
        return {
          totalUpdatedCells: res.data.totalUpdatedCells ?? 0,
          totalUpdatedRows: res.data.totalUpdatedRows ?? 0,
          responses,
        };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_find_rows ───────────────────────────────────────────────────────

const FindRowsInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_name: z.string().optional().describe('Sheet tab name (default: first sheet).'),
  column: z.string().describe('Header name of the column to search (from row 1).'),
  equals: z
    .string()
    .optional()
    .describe('Return rows where the column value exactly equals this string.'),
  contains: z
    .string()
    .optional()
    .describe('Return rows where the column value contains this substring (case-sensitive).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Max matching rows to return (default 100, max 1000).'),
});

export type FindRowsOutput = {
  column: string;
  rowCount: number;
  headers: string[];
  rows: Array<Record<string, string | number | boolean>>;
};

export function createFindRowsTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof FindRowsInput, FindRowsOutput> {
  return {
    name: 'sheets_find_rows',
    description:
      'Find rows in a Google Sheet where a column matches a value. ' +
      'More efficient than reading all rows when you know what you are looking for. ' +
      'Provide exactly one of: equals or contains.',
    inputSchema: FindRowsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const provided = [input.equals, input.contains].filter((v) => v !== undefined);
        if (provided.length !== 1) {
          throw new SheetsAdapterError(
            'sheets_validation_error',
            'Provide exactly one of: equals, contains.',
          );
        }

        // Resolve sheet name
        let sheetName = input.sheet_name;
        if (!sheetName) {
          const meta = await sheets.spreadsheets.get({
            spreadsheetId: input.spreadsheet_id,
            fields: 'sheets.properties.title',
          });
          sheetName = meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
        }

        const range = `'${sheetName.replace(/'/g, "''")}'`;
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: input.spreadsheet_id,
          range,
          valueRenderOption: 'FORMATTED_VALUE',
        });

        const raw = res.data.values ?? [];
        if (raw.length === 0) {
          return { column: input.column, rowCount: 0, headers: [], rows: [] };
        }

        const headers = (raw[0] ?? []).map((h) => String(h ?? ''));
        const colIdx = headers.indexOf(input.column);
        if (colIdx === -1) {
          throw new SheetsAdapterError(
            'sheets_validation_error',
            `Column '${input.column}' not found. Available columns: ${headers.join(', ')}`,
          );
        }

        const limit = input.limit ?? 100;
        const dataRows = raw.slice(1);
        const matches: Array<Record<string, string | number | boolean>> = [];

        for (let i = 0; i < dataRows.length && matches.length < limit; i++) {
          const row = dataRows[i] ?? [];
          const cellValue = String(row[colIdx] ?? '');
          const match =
            input.equals !== undefined
              ? cellValue === input.equals
              : cellValue.includes(input.contains!);

          if (match) {
            const record: Record<string, string | number | boolean> = { _row: i + 2 };
            for (let j = 0; j < headers.length; j++) {
              const h = headers[j];
              if (h !== undefined) {
                const v = row[j];
                record[h] = v === null || v === undefined ? '' : (v as string | number | boolean);
              }
            }
            matches.push(record);
          }
        }

        return { column: input.column, rowCount: matches.length, headers, rows: matches };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}
