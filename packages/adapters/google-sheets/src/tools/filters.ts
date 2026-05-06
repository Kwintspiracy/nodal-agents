// @nodalai/adapter-google-sheets — filter and sort tools
// set_basic_filter, clear_basic_filter, sort_range

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { sheets_v4 } from 'googleapis';
import { mapSheetsError } from '../errors';
import {
  buildClearBasicFilterRequest,
  buildSetBasicFilterRequest,
  buildSortRangeRequest,
} from '../helpers/batch-update';

// ── sheets_set_basic_filter ────────────────────────────────────────────────

const SetBasicFilterInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  start_row_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start row index (inclusive). Usually 0 for the header row.'),
  end_row_index: z.number().int().min(1).describe('Zero-based end row index (exclusive).'),
  start_column_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start column index (inclusive).'),
  end_column_index: z.number().int().min(1).describe('Zero-based end column index (exclusive).'),
});

export type SetBasicFilterOutput = {
  filterApplied: boolean;
  sheetId: number;
};

export function createSetBasicFilterTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof SetBasicFilterInput, SetBasicFilterOutput> {
  return {
    name: 'sheets_set_basic_filter',
    description:
      'Apply a basic auto-filter to a range in a Google Sheet. ' +
      'Adds dropdown arrows to the header row for filtering. ' +
      'Uses zero-based row/column indices.',
    inputSchema: SetBasicFilterInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [
              buildSetBasicFilterRequest(
                input.sheet_id,
                input.start_row_index,
                input.end_row_index,
                input.start_column_index,
                input.end_column_index,
              ),
            ],
          },
        });
        return { filterApplied: true, sheetId: input.sheet_id };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_clear_basic_filter ──────────────────────────────────────────────

const ClearBasicFilterInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
});

export type ClearBasicFilterOutput = {
  filterCleared: boolean;
  sheetId: number;
};

export function createClearBasicFilterTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof ClearBasicFilterInput, ClearBasicFilterOutput> {
  return {
    name: 'sheets_clear_basic_filter',
    description: 'Remove the basic auto-filter from a sheet tab.',
    inputSchema: ClearBasicFilterInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [buildClearBasicFilterRequest(input.sheet_id)],
          },
        });
        return { filterCleared: true, sheetId: input.sheet_id };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_sort_range ──────────────────────────────────────────────────────

const SortSpecSchema = z.object({
  dimension_index: z.number().int().min(0).describe('Zero-based column index to sort by.'),
  sort_order: z
    .enum(['ASCENDING', 'DESCENDING'])
    .describe("Sort direction: 'ASCENDING' or 'DESCENDING'."),
});

const SortRangeInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  start_row_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start row index (inclusive). Set to 1 to exclude the header row.'),
  end_row_index: z.number().int().min(1).describe('Zero-based end row index (exclusive).'),
  start_column_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start column index (inclusive).'),
  end_column_index: z.number().int().min(1).describe('Zero-based end column index (exclusive).'),
  sort_specs: z
    .array(SortSpecSchema)
    .min(1)
    .describe(
      'Array of sort specs (primary, secondary, ...). Each: { dimension_index, sort_order }. ' +
        "Example: [{ dimension_index: 2, sort_order: 'DESCENDING' }].",
    ),
});

export type SortRangeOutput = {
  sorted: boolean;
  sheetId: number;
};

export function createSortRangeTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof SortRangeInput, SortRangeOutput> {
  return {
    name: 'sheets_sort_range',
    description:
      'Sort a range of cells in a Google Sheet by one or more columns. ' +
      'Supports multi-level sort (primary + secondary columns). ' +
      'Uses zero-based row/column indices.',
    inputSchema: SortRangeInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [
              buildSortRangeRequest(
                input.sheet_id,
                input.start_row_index,
                input.end_row_index,
                input.start_column_index,
                input.end_column_index,
                input.sort_specs.map((s) => ({
                  dimensionIndex: s.dimension_index,
                  sortOrder: s.sort_order,
                })),
              ),
            ],
          },
        });
        return { sorted: true, sheetId: input.sheet_id };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}
