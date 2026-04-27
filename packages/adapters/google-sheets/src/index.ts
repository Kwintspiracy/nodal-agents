// @nodalai/adapter-google-sheets — public API
// Single factory: createSheetsTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodalai/tools';
import type { z } from 'zod';
import { createSheetsClient } from './client.js';

// Values (8)
import { createReadRangeTool } from './tools/values.js';
import { createReadAllTool } from './tools/values.js';
import { createBatchReadRangesTool } from './tools/values.js';
import { createWriteRangeTool } from './tools/values.js';
import { createAppendRowTool } from './tools/values.js';
import { createClearRangeTool } from './tools/values.js';
import { createBatchUpdateValuesTool } from './tools/values.js';
import { createFindRowsTool } from './tools/values.js';

// Structure (6)
import { createGetMetadataTool } from './tools/structure.js';
import { createCreateSpreadsheetTool } from './tools/structure.js';
import { createAddSheetTool } from './tools/structure.js';
import { createDeleteSheetTool } from './tools/structure.js';
import { createDuplicateSheetTool } from './tools/structure.js';
import { createRenameSheetTool } from './tools/structure.js';

// Format (3)
import { createFormatRangeTool } from './tools/format.js';
import { createResizeColumnsTool } from './tools/format.js';
import { createFreezePanesTool } from './tools/format.js';

// Filters (3)
import { createSetBasicFilterTool } from './tools/filters.js';
import { createClearBasicFilterTool } from './tools/filters.js';
import { createSortRangeTool } from './tools/filters.js';

export interface SheetsAdapterOptions {
  /**
   * User's current OAuth2 access token for Google Sheets.
   * Token refresh is the runner's responsibility — if the token expires,
   * tools throw SheetsAdapterError({ code: 'sheets_unauthorized' }).
   */
  accessToken: string;
}

/**
 * Create all 20 Google Sheets tools using the provided OAuth access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 20
 * Read (5):        sheets_read_range, sheets_read_all, sheets_batch_read_ranges,
 *                  sheets_get_metadata, sheets_find_rows
 * Write (14):      sheets_write_range, sheets_append_row, sheets_clear_range,
 *                  sheets_batch_update_values, sheets_create_spreadsheet,
 *                  sheets_add_sheet, sheets_duplicate_sheet, sheets_rename_sheet,
 *                  sheets_format_range, sheets_resize_columns, sheets_freeze_panes,
 *                  sheets_set_basic_filter, sheets_clear_basic_filter, sheets_sort_range
 * Destructive (1): sheets_delete_sheet
 */
export function createSheetsTools(
  opts: SheetsAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const sheets = createSheetsClient(opts.accessToken);

  return [
    // Read tools (5)
    createReadRangeTool(sheets),
    createReadAllTool(sheets),
    createBatchReadRangesTool(sheets),
    createGetMetadataTool(sheets),
    createFindRowsTool(sheets),

    // Write tools (14)
    createWriteRangeTool(sheets),
    createAppendRowTool(sheets),
    createClearRangeTool(sheets),
    createBatchUpdateValuesTool(sheets),
    createCreateSpreadsheetTool(sheets),
    createAddSheetTool(sheets),
    createDuplicateSheetTool(sheets),
    createRenameSheetTool(sheets),
    createFormatRangeTool(sheets),
    createResizeColumnsTool(sheets),
    createFreezePanesTool(sheets),
    createSetBasicFilterTool(sheets),
    createClearBasicFilterTool(sheets),
    createSortRangeTool(sheets),

    // Destructive tools (1)
    createDeleteSheetTool(sheets),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { SheetsAdapterError } from './errors.js';
export type { SheetsErrorCode } from './errors.js';
