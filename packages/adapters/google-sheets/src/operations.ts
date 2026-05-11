// Google Sheets adapter operation descriptors.
// Each slug MUST match the tool name produced by createSheetsTools() exactly.
// Risk classification:
//   read        — sheets_read_range, sheets_read_all, sheets_batch_read_ranges,
//                 sheets_get_metadata, sheets_find_rows
//   write       — sheets_write_range, sheets_append_row, sheets_clear_range,
//                 sheets_batch_update_values, sheets_create_spreadsheet,
//                 sheets_add_sheet, sheets_duplicate_sheet, sheets_rename_sheet,
//                 sheets_format_range, sheets_resize_columns, sheets_freeze_panes,
//                 sheets_set_basic_filter, sheets_clear_basic_filter, sheets_sort_range
//   destructive — sheets_delete_sheet

import type { OperationDescriptor } from '@nodalai/shared';

export const SHEETS_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'sheets_read_range',
    name: 'Read range',
    risk: 'read',
    requiresApproval: false,
    description: 'Read values from a cell range (e.g. A1:C10).',
  },
  {
    slug: 'sheets_read_all',
    name: 'Read all',
    risk: 'read',
    requiresApproval: false,
    description: 'Read all values from a sheet.',
  },
  {
    slug: 'sheets_batch_read_ranges',
    name: 'Batch read ranges',
    risk: 'read',
    requiresApproval: false,
    description: 'Read multiple cell ranges in a single request.',
  },
  {
    slug: 'sheets_get_metadata',
    name: 'Get metadata',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve spreadsheet metadata and sheet list.',
  },
  {
    slug: 'sheets_find_rows',
    name: 'Find rows',
    risk: 'read',
    requiresApproval: false,
    description: 'Search rows matching a column value.',
  },

  // ─── Write (14) ──────────────────────────────────────────────────────────────
  {
    slug: 'sheets_write_range',
    name: 'Write range',
    risk: 'write',
    requiresApproval: false,
    description: 'Write values to a cell range.',
  },
  {
    slug: 'sheets_append_row',
    name: 'Append row',
    risk: 'write',
    requiresApproval: false,
    description: 'Append a new row at the end of a sheet.',
  },
  {
    slug: 'sheets_clear_range',
    name: 'Clear range',
    risk: 'write',
    requiresApproval: false,
    description: 'Clear values in a cell range.',
  },
  {
    slug: 'sheets_batch_update_values',
    name: 'Batch update values',
    risk: 'write',
    requiresApproval: false,
    description: 'Write values to multiple ranges in one request.',
  },
  {
    slug: 'sheets_create_spreadsheet',
    name: 'Create spreadsheet',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new Google Sheets spreadsheet.',
  },
  {
    slug: 'sheets_add_sheet',
    name: 'Add sheet',
    risk: 'write',
    requiresApproval: false,
    description: 'Add a new sheet tab to a spreadsheet.',
  },
  {
    slug: 'sheets_duplicate_sheet',
    name: 'Duplicate sheet',
    risk: 'write',
    requiresApproval: false,
    description: 'Duplicate an existing sheet tab.',
  },
  {
    slug: 'sheets_rename_sheet',
    name: 'Rename sheet',
    risk: 'write',
    requiresApproval: false,
    description: 'Rename a sheet tab.',
  },
  {
    slug: 'sheets_format_range',
    name: 'Format range',
    risk: 'write',
    requiresApproval: false,
    description: 'Apply formatting (bold, color, number format) to a cell range.',
  },
  {
    slug: 'sheets_resize_columns',
    name: 'Resize columns',
    risk: 'write',
    requiresApproval: false,
    description: 'Resize column widths in a sheet.',
  },
  {
    slug: 'sheets_freeze_panes',
    name: 'Freeze panes',
    risk: 'write',
    requiresApproval: false,
    description: 'Freeze rows or columns in a sheet.',
  },
  {
    slug: 'sheets_set_basic_filter',
    name: 'Set basic filter',
    risk: 'write',
    requiresApproval: false,
    description: 'Apply a basic filter to a sheet range.',
  },
  {
    slug: 'sheets_clear_basic_filter',
    name: 'Clear basic filter',
    risk: 'write',
    requiresApproval: false,
    description: 'Remove the basic filter from a sheet.',
  },
  {
    slug: 'sheets_sort_range',
    name: 'Sort range',
    risk: 'write',
    requiresApproval: false,
    description: 'Sort a range by one or more columns.',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'sheets_delete_sheet',
    name: 'Delete sheet',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a sheet tab from a spreadsheet.',
  },
];
