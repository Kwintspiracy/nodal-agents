// @nodal-agents/adapter-google-sheets — public API
// Single factory: createSheetsTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createSheetsClient } from './client';

// Values (8)
import { createReadRangeTool } from './tools/values';
import { createReadAllTool } from './tools/values';
import { createBatchReadRangesTool } from './tools/values';
import { createWriteRangeTool } from './tools/values';
import { createAppendRowTool } from './tools/values';
import { createClearRangeTool } from './tools/values';
import { createBatchUpdateValuesTool } from './tools/values';
import { createFindRowsTool } from './tools/values';

// Structure (6)
import { createGetMetadataTool } from './tools/structure';
import { createCreateSpreadsheetTool } from './tools/structure';
import { createAddSheetTool } from './tools/structure';
import { createDeleteSheetTool } from './tools/structure';
import { createDuplicateSheetTool } from './tools/structure';
import { createRenameSheetTool } from './tools/structure';

// Format (3)
import { createFormatRangeTool } from './tools/format';
import { createResizeColumnsTool } from './tools/format';
import { createFreezePanesTool } from './tools/format';

// Filters (3)
import { createSetBasicFilterTool } from './tools/filters';
import { createClearBasicFilterTool } from './tools/filters';
import { createSortRangeTool } from './tools/filters';

export type SheetsAdapterOptions =
  | {
      /**
       * Static OAuth2 access token, captured once for the tools' lifetime.
       * Fine for short-lived callers (tests, the UI operations grid). Jobs
       * that may outlive the ~1h Google token TTL should pass getAccessToken
       * instead (audit#2 M-12).
       */
      accessToken: string;
    }
  | {
      /**
       * Resolver called before every Sheets API request — re-reads (and, via
       * the runner's advisory-lock refresh path, refreshes) the credential
       * from the DB instead of capturing one token for the tools' lifetime.
       */
      getAccessToken: () => Promise<string>;
    };

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
  const getAccessToken =
    'getAccessToken' in opts ? opts.getAccessToken : async () => opts.accessToken;
  const sheets = createSheetsClient(getAccessToken);

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
export { SheetsAdapterError } from './errors';
export type { SheetsErrorCode } from './errors';

// Re-export operation descriptors for UI and registry consumers
export { SHEETS_OPERATIONS } from './operations';
