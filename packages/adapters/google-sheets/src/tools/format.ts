// @nodalai/adapter-google-sheets — formatting tools
// format_range, resize_columns, freeze_panes

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { sheets_v4 } from 'googleapis';
import { mapSheetsError, SheetsAdapterError } from '../errors';
import {
  buildAutoResizeColumnsRequest,
  buildFormatRangeRequest,
  buildFreezeRequest,
  buildResizeColumnsRequest,
} from '../helpers/batch-update';

// ── sheets_format_range ────────────────────────────────────────────────────

const FormatRangeInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  start_row_index: z.number().int().min(0).describe('Zero-based start row index (inclusive).'),
  end_row_index: z
    .number()
    .int()
    .min(1)
    .describe('Zero-based end row index (exclusive). E.g. rows 0–1 → endRowIndex=1.'),
  start_column_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start column index (inclusive).'),
  end_column_index: z
    .number()
    .int()
    .min(1)
    .describe('Zero-based end column index (exclusive). E.g. columns 0–3 → endColumnIndex=3.'),
  bold: z.boolean().optional().describe('Set bold text.'),
  italic: z.boolean().optional().describe('Set italic text.'),
  font_size: z.number().int().min(1).optional().describe('Font size in points.'),
  background_color: z
    .object({
      red: z.number().min(0).max(1).describe('Red channel 0–1.'),
      green: z.number().min(0).max(1).describe('Green channel 0–1.'),
      blue: z.number().min(0).max(1).describe('Blue channel 0–1.'),
    })
    .optional()
    .describe('Background fill color (RGB, each channel 0–1).'),
  foreground_color: z
    .object({
      red: z.number().min(0).max(1).describe('Red channel 0–1.'),
      green: z.number().min(0).max(1).describe('Green channel 0–1.'),
      blue: z.number().min(0).max(1).describe('Blue channel 0–1.'),
    })
    .optional()
    .describe('Text foreground color (RGB, each channel 0–1).'),
  number_format: z
    .object({
      type: z
        .enum(['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC'])
        .describe('Number format type.'),
      pattern: z
        .string()
        .optional()
        .describe("Optional format pattern, e.g. '#,##0.00' for currency."),
    })
    .optional()
    .describe('Number format to apply.'),
  horizontal_alignment: z
    .enum(['LEFT', 'CENTER', 'RIGHT'])
    .optional()
    .describe('Horizontal text alignment.'),
});

export type FormatRangeOutput = {
  formatted: boolean;
  sheetId: number;
};

export function createFormatRangeTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof FormatRangeInput, FormatRangeOutput> {
  return {
    name: 'sheets_format_range',
    description:
      'Apply formatting to a cell range in a Google Sheet: bold, italic, font size, background color, ' +
      'text color, number format, and alignment. Uses zero-based row/column indices.',
    inputSchema: FormatRangeInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const format: sheets_v4.Schema$CellFormat = {};
        const fields: string[] = [];

        const textFmt: sheets_v4.Schema$TextFormat = {};
        if (input.bold !== undefined) {
          textFmt.bold = input.bold;
          fields.push('textFormat.bold');
        }
        if (input.italic !== undefined) {
          textFmt.italic = input.italic;
          fields.push('textFormat.italic');
        }
        if (input.font_size !== undefined) {
          textFmt.fontSize = input.font_size;
          fields.push('textFormat.fontSize');
        }
        if (input.foreground_color !== undefined) {
          textFmt.foregroundColor = {
            red: input.foreground_color.red,
            green: input.foreground_color.green,
            blue: input.foreground_color.blue,
          };
          fields.push('textFormat.foregroundColor');
        }
        if (Object.keys(textFmt).length > 0) {
          format.textFormat = textFmt;
        }

        if (input.background_color !== undefined) {
          format.backgroundColor = {
            red: input.background_color.red,
            green: input.background_color.green,
            blue: input.background_color.blue,
          };
          fields.push('backgroundColor');
        }

        if (input.number_format !== undefined) {
          format.numberFormat = {
            type: input.number_format.type,
            ...(input.number_format.pattern !== undefined && {
              pattern: input.number_format.pattern,
            }),
          };
          fields.push('numberFormat');
        }

        if (input.horizontal_alignment !== undefined) {
          format.horizontalAlignment = input.horizontal_alignment;
          fields.push('horizontalAlignment');
        }

        if (fields.length === 0) {
          throw new SheetsAdapterError(
            'sheets_validation_error',
            'Provide at least one formatting property.',
          );
        }

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [
              buildFormatRangeRequest(
                input.sheet_id,
                input.start_row_index,
                input.end_row_index,
                input.start_column_index,
                input.end_column_index,
                format,
                fields.join(','),
              ),
            ],
          },
        });
        return { formatted: true, sheetId: input.sheet_id };
      } catch (err) {
        if (err instanceof SheetsAdapterError) throw err;
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_resize_columns ──────────────────────────────────────────────────

const ResizeColumnsInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  start_column_index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based start column index (inclusive).'),
  end_column_index: z
    .number()
    .int()
    .min(1)
    .describe('Zero-based end column index (exclusive). E.g. columns 0–3 → endColumnIndex=3.'),
  pixel_size: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Column width in pixels. Omit to auto-resize to fit content.'),
});

export type ResizeColumnsOutput = {
  resized: boolean;
  sheetId: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

export function createResizeColumnsTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof ResizeColumnsInput, ResizeColumnsOutput> {
  return {
    name: 'sheets_resize_columns',
    description:
      'Resize columns in a Google Sheet. Provide pixel_size for a fixed width, ' +
      'or omit to auto-resize columns to fit their content.',
    inputSchema: ResizeColumnsInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const request =
          input.pixel_size !== undefined
            ? buildResizeColumnsRequest(
                input.sheet_id,
                input.start_column_index,
                input.end_column_index,
                input.pixel_size,
              )
            : buildAutoResizeColumnsRequest(
                input.sheet_id,
                input.start_column_index,
                input.end_column_index,
              );

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: { requests: [request] },
        });
        return {
          resized: true,
          sheetId: input.sheet_id,
          startColumnIndex: input.start_column_index,
          endColumnIndex: input.end_column_index,
        };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}

// ── sheets_freeze_panes ────────────────────────────────────────────────────

const FreezePanesInput = z.object({
  spreadsheet_id: z.string().describe('The spreadsheet ID from the URL (between /d/ and /edit).'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Get it from sheets_get_metadata.'),
  frozen_row_count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of rows to freeze at the top (0 to unfreeze, default 0).'),
  frozen_column_count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of columns to freeze at the left (0 to unfreeze, default 0).'),
});

export type FreezePanesOutput = {
  frozenRowCount: number;
  frozenColumnCount: number;
  sheetId: number;
};

export function createFreezePanesTool(
  sheets: sheets_v4.Sheets,
): ToolDefinition<typeof FreezePanesInput, FreezePanesOutput> {
  return {
    name: 'sheets_freeze_panes',
    description:
      'Freeze rows and/or columns in a Google Sheet so they stay visible while scrolling. ' +
      'Set frozen_row_count=1 to freeze the header row. Set to 0 to unfreeze.',
    inputSchema: FreezePanesInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const frozenRows = input.frozen_row_count ?? 0;
        const frozenCols = input.frozen_column_count ?? 0;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: input.spreadsheet_id,
          requestBody: {
            requests: [buildFreezeRequest(input.sheet_id, frozenRows, frozenCols)],
          },
        });
        return {
          frozenRowCount: frozenRows,
          frozenColumnCount: frozenCols,
          sheetId: input.sheet_id,
        };
      } catch (err) {
        throw mapSheetsError(err);
      }
    },
  };
}
