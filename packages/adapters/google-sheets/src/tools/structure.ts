// @nodalai/adapter-google-sheets — structure tools
// get_metadata, create_spreadsheet, add_sheet, delete_sheet, duplicate_sheet, rename_sheet

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { sheets_v4 } from 'googleapis';
import { mapSheetsError, SheetsAdapterError } from '../errors';
import {
  buildDeleteSheetRequest,
  buildDuplicateSheetRequest,
  buildRenameSheetRequest,
} from '../helpers/batch-update';

// ── sheets_get_metadata ────────────────────────────────────────────────────

const GetMetadataInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
});

export type SheetTab = {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  colCount: number;
  hidden: boolean;
};

export type GetMetadataOutput = {
  spreadsheetId: string;
  title: string;
  url: string;
  sheets: SheetTab[];
  namedRanges: Array<{ name: string; range: string }>;
};

export function createGetMetadataTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof GetMetadataInput, GetMetadataOutput> {
  return {
    name: 'sheets_get_metadata',
    description:
      'Get metadata about a Google Spreadsheet: title, list of sheet tabs with their dimensions, ' +
      'and named ranges. Use this to discover sheet names before reading.',
    inputSchema: GetMetadataInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await sheets.spreadsheets.get({
          spreadsheetId: input.spreadsheet_id,
          fields: 'spreadsheetId,properties.title,spreadsheetUrl,sheets.properties,namedRanges',
        });
        const sp = res.data;
        const sheetTabs: SheetTab[] = (sp.sheets ?? []).map((s) => ({
          sheetId: s.properties?.sheetId ?? 0,
          title: s.properties?.title ?? '',
          index: s.properties?.index ?? 0,
          rowCount: s.properties?.gridProperties?.rowCount ?? 0,
          colCount: s.properties?.gridProperties?.columnCount ?? 0,
          hidden: s.properties?.hidden ?? false,
        }));
        const namedRanges = (sp.namedRanges ?? []).map((nr) => ({
          name: nr.name ?? '',
          range: nr.range
            ? `${nr.range.sheetId}!R${nr.range.startRowIndex}C${nr.range.startColumnIndex}:R${nr.range.endRowIndex}C${nr.range.endColumnIndex}`
            : '',
        }));
        return {
          spreadsheetId: sp.spreadsheetId ?? input.spreadsheet_id,
          title: sp.properties?.title ?? '',
          url: sp.spreadsheetUrl ?? '',
          sheets: sheetTabs,
          namedRanges,
        };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_create_spreadsheet ──────────────────────────────────────────────

const CreateSpreadsheetInput = z.object({
  title: z.string().describe('Title for the new spreadsheet.'),
  sheet_title: z.string().optional().describe("Title for the first sheet tab (default: 'Sheet1')."),
});

export type CreateSpreadsheetOutput = {
  spreadsheetId: string;
  title: string;
  url: string;
  firstSheetId: number;
};

export function createCreateSpreadsheetTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof CreateSpreadsheetInput, CreateSpreadsheetOutput> {
  return {
    name: 'sheets_create_spreadsheet',
    description:
      'Create a new Google Spreadsheet. Returns the spreadsheet ID and URL. ' +
      'The new spreadsheet will be placed in the root of the authenticated user Drive.',
    inputSchema: CreateSpreadsheetInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: input.title },
            sheets: [
              {
                properties: {
                  title: input.sheet_title ?? 'Sheet1',
                },
              },
            ],
          },
        });
        return {
          spreadsheetId: res.data.spreadsheetId ?? '',
          title: res.data.properties?.title ?? input.title,
          url: res.data.spreadsheetUrl ?? '',
          firstSheetId: res.data.sheets?.[0]?.properties?.sheetId ?? 0,
        };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_add_sheet ────────────────────────────────────────────────────────

const AddSheetInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  title: z.string().describe('Title for the new sheet tab.'),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based position to insert the sheet (default: appended at end).'),
});

export type AddSheetOutput = {
  sheetId: number;
  title: string;
  index: number;
};

export function createAddSheetTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof AddSheetInput, AddSheetOutput> {
  return {
    name: 'sheets_add_sheet',
    description: 'Add a new sheet tab to an existing Google Spreadsheet.',
    inputSchema: AddSheetInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: input.title,
                    ...(input.index !== undefined && { index: input.index }),
                  },
                },
              },
            ],
          },
        });
        const added = res.data.replies?.[0]?.addSheet?.properties;
        return {
          sheetId: added?.sheetId ?? 0,
          title: added?.title ?? input.title,
          index: added?.index ?? 0,
        };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_delete_sheet ────────────────────────────────────────────────────

const DeleteSheetInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z
    .number()
    .int()
    .describe('Numeric sheet ID (not the tab name). Get it from sheets_get_metadata.'),
});

export type DeleteSheetOutput = {
  deleted: boolean;
  sheetId: number;
};

export function createDeleteSheetTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof DeleteSheetInput, DeleteSheetOutput> {
  return {
    name: 'sheets_delete_sheet',
    description:
      'Permanently delete a sheet tab from a Google Spreadsheet. This is irreversible. ' +
      'Get the numeric sheetId from sheets_get_metadata (not the tab name).',
    inputSchema: DeleteSheetInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: { requests: [buildDeleteSheetRequest(input.sheet_id)] },
        });
        return { deleted: true, sheetId: input.sheet_id };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_duplicate_sheet ─────────────────────────────────────────────────

const DuplicateSheetInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  source_sheet_id: z
    .number()
    .int()
    .describe('Numeric ID of the sheet to duplicate. Get it from sheets_get_metadata.'),
  new_sheet_name: z
    .string()
    .optional()
    .describe('Name for the duplicated sheet (defaults to "Copy of <original>").'),
  insert_sheet_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based position to insert the duplicate (default: appended at end).'),
});

export type DuplicateSheetOutput = {
  sheetId: number;
  title: string;
  index: number;
};

export function createDuplicateSheetTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof DuplicateSheetInput, DuplicateSheetOutput> {
  return {
    name: 'sheets_duplicate_sheet',
    description:
      'Copy a sheet tab within the same Google Spreadsheet. ' +
      'Duplicates all data, formatting, and formulas.',
    inputSchema: DuplicateSheetInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Determine insert index: default to last position
        let insertIndex = input.insert_sheet_index;
        if (insertIndex === undefined) {
          const meta = await sheets.spreadsheets.get({
            spreadsheetId: input.spreadsheet_id,
            fields: 'sheets.properties.index',
          });
          insertIndex = meta.data.sheets?.length ?? 1;
        }

        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [
              buildDuplicateSheetRequest(input.source_sheet_id, insertIndex, input.new_sheet_name),
            ],
          },
        });
        const dup = res.data.replies?.[0]?.duplicateSheet?.properties;
        return {
          sheetId: dup?.sheetId ?? 0,
          title: dup?.title ?? input.new_sheet_name ?? '',
          index: dup?.index ?? insertIndex,
        };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_rename_sheet ────────────────────────────────────────────────────

const RenameSheetInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  new_title: z.string().describe('New tab name for the sheet.'),
});

export type RenameSheetOutput = {
  sheetId: number;
  title: string;
};

export function createRenameSheetTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof RenameSheetInput, RenameSheetOutput> {
  return {
    name: 'sheets_rename_sheet',
    description: 'Rename a sheet tab in a Google Spreadsheet.',
    inputSchema: RenameSheetInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [buildRenameSheetRequest(input.sheet_id, input.new_title)],
          },
        });
        return { sheetId: input.sheet_id, title: input.new_title };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}
