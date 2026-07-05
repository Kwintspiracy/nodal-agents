// office-ops/xlsx.ts — Excel workbook tools (exceljs, lossless in-place edit)
//
// Design principles:
//   - ALL mutations follow the read-mutate-write cycle: load the workbook from
//     disk, apply the change, save back to the same path. exceljs preserves
//     formulae, styles, charts, and other cells untouched.
//   - Path traversal / symlink protection delegated to readWorkspaceBinary +
//     writeWorkspaceBinary (which call resolveAndCheckPath internally).
//   - Outputs are discriminated unions {ok:true,...} | {ok:false,reason}.
//     Every error path returns ok:false rather than throwing so the agent sees
//     a clear reason in its tool_result.

import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Load an ExcelJS workbook from a workspace-relative path. */
async function loadWorkbook(
  ctx: Parameters<ToolDefinition<z.ZodTypeAny, unknown>['execute']>[1],
  path: string,
): Promise<
  { ok: true; workbook: ExcelJS.Workbook; resolvedPath: string } | { ok: false; reason: string }
> {
  const readResult = await readWorkspaceBinary(ctx, path);
  if (!readResult.ok) return readResult;
  const workbook = new ExcelJS.Workbook();
  // exceljs types pre-date @types/node generic Buffer → cast to unknown
  await (workbook.xlsx.load as (b: unknown) => Promise<ExcelJS.Workbook>)(readResult.buffer);
  return { ok: true, workbook, resolvedPath: readResult.resolvedPath };
}

/** Serialise a workbook back to a Buffer and write it atomically. */
async function saveWorkbook(
  ctx: Parameters<ToolDefinition<z.ZodTypeAny, unknown>['execute']>[1],
  workbook: ExcelJS.Workbook,
  resolvedPath: string,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  // writeBuffer() returns a Buffer containing the xlsx bytes.
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // overwrite:true — we always replace the source file after mutation.
  const writeResult = await writeWorkspaceBinary(ctx, resolvedPath, buffer, { overwrite: true });
  if (!writeResult.ok) return writeResult;
  return { ok: true, bytes: buffer.length };
}

/** Find a worksheet by name or fall back to the first sheet. */
function getSheet(workbook: ExcelJS.Workbook, sheet?: string): ExcelJS.Worksheet | null {
  if (sheet) {
    const ws = workbook.getWorksheet(sheet);
    return ws ?? null;
  }
  // First worksheet
  let first: ExcelJS.Worksheet | null = null;
  workbook.eachSheet((ws) => {
    if (!first) first = ws;
  });
  return first;
}

// ─── xlsx_read ────────────────────────────────────────────────────────────────

const XlsxReadInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Workspace-relative path to the .xlsx file. For multi-workspace agents, prefix with the workspace label (e.g. "docs/report.xlsx").',
    ),
  sheet: z.string().optional().describe('Worksheet name. Defaults to the first sheet if omitted.'),
  max_rows: z
    .number()
    .int()
    .positive()
    .optional()
    .default(200)
    .describe('Maximum rows to return per sheet. Default 200.'),
});

type XlsxReadOutput =
  | {
      ok: true;
      sheets: Array<{
        name: string;
        rows: Array<Array<string | null>>;
        truncated: boolean;
      }>;
    }
  | { ok: false; reason: string };

export const xlsxReadTool: ToolDefinition<typeof XlsxReadInput, XlsxReadOutput> = {
  name: 'xlsx_read',
  description:
    'Read an Excel (.xlsx) workbook from the agent workspace. Returns rows as arrays of strings. ' +
    'Formula cells return their cached result. Dates are ISO-formatted (YYYY-MM-DD). ' +
    'Set max_rows to control how many rows are returned per sheet.',
  inputSchema: XlsxReadInput,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    const load = await loadWorkbook(ctx, input.path);
    if (!load.ok) return load;
    const { workbook } = load;

    const MAX = input.max_rows;
    const sheets: Array<{ name: string; rows: Array<Array<string | null>>; truncated: boolean }> =
      [];

    const targetSheet = input.sheet ? getSheet(workbook, input.sheet) : null;
    const processSheet = (ws: ExcelJS.Worksheet): void => {
      const rows: Array<Array<string | null>> = [];
      let truncated = false;
      let rowCount = 0;
      ws.eachRow((row) => {
        if (rowCount >= MAX) {
          truncated = true;
          return;
        }
        const cells: Array<string | null> = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          const val = cell.value;
          if (val === null || val === undefined) {
            cells.push(null);
          } else if (typeof val === 'object' && 'result' in val) {
            cells.push(String((val as { result: unknown }).result ?? ''));
          } else if (val instanceof Date) {
            cells.push(val.toISOString().slice(0, 10));
          } else if (typeof val === 'object' && 'text' in val) {
            cells.push(String((val as { text: unknown }).text ?? ''));
          } else {
            cells.push(String(val));
          }
        });
        rows.push(cells);
        rowCount++;
      });
      sheets.push({ name: ws.name, rows, truncated });
    };

    if (targetSheet) {
      processSheet(targetSheet);
    } else {
      workbook.eachSheet((ws) => processSheet(ws));
    }

    return { ok: true, sheets };
  },
};

// ─── xlsx_set_cell ────────────────────────────────────────────────────────────

const XlsxSetCellInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  cell: z
    .string()
    .min(1)
    .describe('Cell address in A1 notation (e.g. "B3"). Column letter(s) then row number.'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe(
      'New cell value. Strings starting with "=" are treated as formulae. ' +
        'null clears the cell.',
    ),
});

type XlsxSetCellOutput = { ok: true; cell: string; sheet: string } | { ok: false; reason: string };

export const xlsxSetCellTool: ToolDefinition<typeof XlsxSetCellInput, XlsxSetCellOutput> = {
  name: 'xlsx_set_cell',
  description:
    'Set a single cell value in an Excel workbook. Other cells, formulae, and styles are ' +
    'preserved (lossless in-place edit via exceljs). The workbook is saved back to the same ' +
    'path atomically.',
  inputSchema: XlsxSetCellInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const load = await loadWorkbook(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    const cell = ws.getCell(input.cell);
    if (input.value === null) {
      cell.value = null;
    } else if (typeof input.value === 'string' && input.value.startsWith('=')) {
      cell.value = { formula: input.value.slice(1) } as ExcelJS.CellFormulaValue;
    } else {
      cell.value = input.value;
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, cell: input.cell, sheet: input.sheet };
  },
};

// ─── xlsx_set_range ───────────────────────────────────────────────────────────

const XlsxSetRangeInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  start_cell: z
    .string()
    .min(1)
    .describe(
      'Top-left cell of the range in A1 notation (e.g. "B2"). The range expands to fit values[][].)',
    ),
  values: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .describe(
      'Row-major 2-D array of values. values[0] = first row, values[0][0] = start_cell. ' +
        'null entries clear the corresponding cell. Strings starting with "=" are formulae.',
    ),
});

type XlsxSetRangeOutput =
  | { ok: true; rows_written: number; cols_written: number }
  | { ok: false; reason: string };

export const xlsxSetRangeTool: ToolDefinition<typeof XlsxSetRangeInput, XlsxSetRangeOutput> = {
  name: 'xlsx_set_range',
  description:
    'Write a 2-D block of values into an Excel workbook starting at start_cell. ' +
    'Other cells outside the range are preserved. Atomic save.',
  inputSchema: XlsxSetRangeInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const load = await loadWorkbook(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    // Parse start_cell into row and column indices
    const startCell = ws.getCell(input.start_cell);
    const startRow = startCell.row;
    const startCol = startCell.col;

    for (let r = 0; r < input.values.length; r++) {
      const rowVals = input.values[r]!;
      for (let c = 0; c < rowVals.length; c++) {
        const cell = ws.getCell(startRow + r, startCol + c);
        const val = rowVals[c];
        if (val === null) {
          cell.value = null;
        } else if (typeof val === 'string' && val.startsWith('=')) {
          cell.value = { formula: val.slice(1) } as ExcelJS.CellFormulaValue;
        } else {
          cell.value = val;
        }
      }
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return {
      ok: true,
      rows_written: input.values.length,
      cols_written: Math.max(0, ...input.values.map((r) => r.length)),
    };
  },
};

// ─── xlsx_append_rows ─────────────────────────────────────────────────────────

const XlsxAppendRowsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .describe(
      'Rows to append after the last populated row. Each entry is a cell value. ' +
        'null clears the cell. Strings starting with "=" are formulae.',
    ),
});

type XlsxAppendRowsOutput =
  | { ok: true; rows_appended: number; new_last_row: number }
  | { ok: false; reason: string };

export const xlsxAppendRowsTool: ToolDefinition<typeof XlsxAppendRowsInput, XlsxAppendRowsOutput> =
  {
    name: 'xlsx_append_rows',
    description:
      'Append rows at the bottom of a worksheet (after the last row with data). ' +
      'Existing data is preserved.',
    inputSchema: XlsxAppendRowsInput,
    riskLevel: 'write',
    execute: async (input, ctx) => {
      const load = await loadWorkbook(ctx, input.path);
      if (!load.ok) return load;
      const { workbook, resolvedPath } = load;

      const ws = getSheet(workbook, input.sheet);
      if (!ws) {
        return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
      }

      const lastRow = ws.lastRow?.number ?? 0;
      for (let i = 0; i < input.rows.length; i++) {
        const rowVals = input.rows[i]!;
        const rowRef = ws.getRow(lastRow + 1 + i);
        rowVals.forEach((val, colIdx) => {
          const cell = rowRef.getCell(colIdx + 1);
          if (val === null) {
            cell.value = null;
          } else if (typeof val === 'string' && val.startsWith('=')) {
            cell.value = { formula: val.slice(1) } as ExcelJS.CellFormulaValue;
          } else {
            cell.value = val;
          }
        });
        rowRef.commit();
      }

      const save = await saveWorkbook(ctx, workbook, resolvedPath);
      if (!save.ok) return save;
      return {
        ok: true,
        rows_appended: input.rows.length,
        new_last_row: lastRow + input.rows.length,
      };
    },
  };

// ─── xlsx_add_sheet ───────────────────────────────────────────────────────────

const XlsxAddSheetInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  name: z.string().min(1).describe('Name of the new worksheet.'),
});

type XlsxAddSheetOutput = { ok: true; sheet: string } | { ok: false; reason: string };

export const xlsxAddSheetTool: ToolDefinition<typeof XlsxAddSheetInput, XlsxAddSheetOutput> = {
  name: 'xlsx_add_sheet',
  description: 'Add a new (empty) worksheet to an existing Excel workbook.',
  inputSchema: XlsxAddSheetInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const load = await loadWorkbook(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    // Check for duplicate sheet name
    if (workbook.getWorksheet(input.name)) {
      return { ok: false, reason: `Sheet "${input.name}" already exists in workbook.` };
    }
    workbook.addWorksheet(input.name);

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, sheet: input.name };
  },
};

// ─── xlsx_create ──────────────────────────────────────────────────────────────

const XlsxCreateInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path for the new .xlsx file (e.g. "reports/q1.xlsx").'),
  sheet: z
    .string()
    .optional()
    .default('Sheet1')
    .describe('Name of the first worksheet. Defaults to "Sheet1".'),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe('If false (default) refuse to overwrite an existing file.'),
});

type XlsxCreateOutput = { ok: true; path: string; sheet: string } | { ok: false; reason: string };

export const xlsxCreateTool: ToolDefinition<typeof XlsxCreateInput, XlsxCreateOutput> = {
  name: 'xlsx_create',
  description:
    'Create a new empty Excel (.xlsx) workbook at the specified workspace path. ' +
    'Fails if the file already exists unless overwrite:true is passed.',
  inputSchema: XlsxCreateInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet(input.sheet);

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, {
      overwrite: input.overwrite,
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, sheet: input.sheet };
  },
};

// ─── xlsx_delete_rows ─────────────────────────────────────────────────────────

const XlsxDeleteRowsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  start_row: z
    .number()
    .int()
    .positive()
    .describe('1-indexed row number of the first row to delete.'),
  count: z.number().int().positive().describe('Number of rows to delete.'),
});

type XlsxDeleteRowsOutput =
  | { ok: true; rows_deleted: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxDeleteRowsTool: ToolDefinition<typeof XlsxDeleteRowsInput, XlsxDeleteRowsOutput> =
  {
    name: 'xlsx_delete_rows',
    description:
      'Delete a range of rows from a worksheet. Rows below the deleted range are shifted up. ' +
      'This is a DESTRUCTIVE operation — rows are permanently removed. Confirm the row range ' +
      'with xlsx_read first. Requires an explicit approval rule or agent-level overwrite consent.',
    inputSchema: XlsxDeleteRowsInput,
    riskLevel: 'destructive',
    defaultApproval: 'require_approval',
    execute: async (input, ctx) => {
      const load = await loadWorkbook(ctx, input.path);
      if (!load.ok) return load;
      const { workbook, resolvedPath } = load;

      const ws = getSheet(workbook, input.sheet);
      if (!ws) {
        return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
      }

      const lastRow = ws.lastRow?.number ?? 0;
      if (input.start_row > lastRow) {
        return {
          ok: false,
          reason: `start_row ${input.start_row} is beyond the last row (${lastRow}) of sheet "${input.sheet}".`,
        };
      }

      ws.spliceRows(input.start_row, input.count);

      const save = await saveWorkbook(ctx, workbook, resolvedPath);
      if (!save.ok) return save;
      return { ok: true, rows_deleted: input.count, sheet: input.sheet };
    },
  };
