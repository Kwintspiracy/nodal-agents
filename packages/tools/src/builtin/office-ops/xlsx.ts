// office-ops/xlsx.ts — Excel workbook tools (exceljs, lossless in-place edit)
//
// Design principles:
//   - ALL mutations follow the read-mutate-write cycle: load the workbook from
//     disk, apply the change, save back to the same path. exceljs preserves
//     formulae and styles across the round-trip, but NOT charts or pivot
//     tables — it has no writer for either (see loadWorkbookForWrite below),
//     so every mutating tool refuses to touch a workbook that contains one
//     instead of silently dropping it from the saved file.
//   - Path traversal / symlink protection delegated to readWorkspaceBinary +
//     writeWorkspaceBinary (which call resolveAndCheckPath internally).
//   - Outputs are discriminated unions {ok:true,...} | {ok:false,reason}.
//     Every error path returns ok:false rather than throwing so the agent sees
//     a clear reason in its tool_result.

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Load an ExcelJS workbook from a workspace-relative path. */
async function loadWorkbook(
  ctx: Parameters<ToolDefinition<z.ZodTypeAny, unknown>['execute']>[1],
  path: string,
): Promise<
  | { ok: true; workbook: ExcelJS.Workbook; resolvedPath: string; buffer: Buffer }
  | { ok: false; reason: string }
> {
  const readResult = await readWorkspaceBinary(ctx, path);
  if (!readResult.ok) return readResult;
  const workbook = new ExcelJS.Workbook();
  // exceljs types pre-date @types/node generic Buffer → cast to unknown
  await (workbook.xlsx.load as (b: unknown) => Promise<ExcelJS.Workbook>)(readResult.buffer);
  return {
    ok: true,
    workbook,
    resolvedPath: readResult.resolvedPath,
    buffer: readResult.buffer,
  };
}

/**
 * Detect zip entries exceljs 4.4 cannot round-trip: it has no chart or
 * pivot-table WRITER, so `workbook.xlsx.load()` followed by `writeBuffer()`
 * silently drops `xl/charts/*`, `xl/pivotTables/*` and `xl/pivotCache/*`
 * parts from the saved file — a real chart/pivot table in the source
 * workbook would be destroyed without a word. Only a listing pass: `JSZip.
 * loadAsync` parses the central directory to enumerate entry names and does
 * NOT decompress anything, so this costs a second cheap zip-directory read,
 * not a second full inflate (same reasoning office-helpers.ts's
 * validateOfficeZipBomb relies on for calling loadAsync safely on untrusted
 * input). Re-parses the buffer readWorkspaceBinary already read into memory
 * — no second disk read.
 */
async function checkNoUnsupportedFeatures(
  buffer: Buffer,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // readWorkspaceBinary already validated this is a well-formed zip
    // (via the same JSZip.loadAsync, inside its bomb check) before this
    // function ever runs — a failure here would mean that guarantee broke,
    // not that this file is unsupported. Let the exceljs load that already
    // succeeded speak for itself rather than block on this pass.
    return { ok: true };
  }
  const entries = Object.keys(zip.files);
  const hasCharts = entries.some((name) => name.startsWith('xl/charts/'));
  const hasPivots = entries.some(
    (name) => name.startsWith('xl/pivotTables/') || name.startsWith('xl/pivotCache/'),
  );
  if (!hasCharts && !hasPivots) return { ok: true };

  const found = [hasCharts ? 'chart(s)' : null, hasPivots ? 'pivot table(s)' : null]
    .filter((s): s is string => s !== null)
    .join(' and ');
  return {
    ok: false,
    reason:
      `This workbook contains ${found} that exceljs (the engine behind every xlsx_* write ` +
      'tool) cannot preserve when saving — writing to it would silently delete them. Work on ' +
      'a copy with the chart/pivot table removed, or make this change on a separate sheet/' +
      'workbook and merge the result in Excel afterwards. Read-only tools (xlsx_read, ' +
      'xlsx_find_cells) are unaffected and remain safe to use on this file.',
  };
}

/**
 * Load a workbook for a MUTATING xlsx_* tool: same as loadWorkbook, but also
 * fails loud (invariant #4 — no silent smart fallback) when the source
 * contains a chart or pivot table exceljs would drop on save. Pure reads
 * (xlsx_read, xlsx_find_cells) call loadWorkbook directly — they never call
 * saveWorkbook, so they can't destroy anything and stay usable on every file.
 */
async function loadWorkbookForWrite(
  ctx: Parameters<ToolDefinition<z.ZodTypeAny, unknown>['execute']>[1],
  path: string,
): Promise<
  { ok: true; workbook: ExcelJS.Workbook; resolvedPath: string } | { ok: false; reason: string }
> {
  const load = await loadWorkbook(ctx, path);
  if (!load.ok) return load;
  const check = await checkNoUnsupportedFeatures(load.buffer);
  if (!check.ok) return check;
  return { ok: true, workbook: load.workbook, resolvedPath: load.resolvedPath };
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

/** Column letter only (e.g. "A", "AB") — used for column-addressed inputs. */
const ColumnLetterSchema = z
  .string()
  .regex(/^[A-Za-z]{1,3}$/, 'Column letter like "A" or "AB" (letters only, no row number).');

/** Hex color, with or without leading "#", 3/6/8 hex digits (8 = ARGB). */
const HexColorSchema = z
  .string()
  .regex(
    /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/,
    'Hex color like "FF0000" or "#FF0000".',
  );

/** Normalise a hex color to exceljs' 8-char ARGB format (e.g. "FF0000" → "FFFF0000"). */
function toArgb(hex: string): string {
  let h = hex.replace(/^#/, '').toUpperCase();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 6) {
    h = `FF${h}`;
  }
  return h;
}

/**
 * Render a cell's raw value as a display string — same extraction rules as
 * xlsx_read's row processing (formula → cached result, date → ISO, rich
 * text → plain text), duplicated locally so xlsx_read's tested behaviour is
 * never touched by these additions.
 */
function stringifyCellValue(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'object' && 'result' in val) {
    return String((val as { result: unknown }).result ?? '');
  }
  if (typeof val === 'object' && 'text' in val) {
    return String((val as { text: unknown }).text ?? '');
  }
  return String(val);
}

/** Apply a plain value to a cell — "=" prefix means formula, null clears it. Same convention as xlsx_set_cell/xlsx_set_range. */
function assignCellValue(cell: ExcelJS.Cell, val: string | number | boolean | null): void {
  if (val === null) {
    cell.value = null;
  } else if (typeof val === 'string' && val.startsWith('=')) {
    cell.value = { formula: val.slice(1) } as ExcelJS.CellFormulaValue;
  } else {
    cell.value = val;
  }
}

const MAX_RANGE_CELLS = 100_000;
const A1_ADDR_RE = /^[A-Za-z]{1,3}[0-9]+$/;

/** Parse an A1-notation range ("A1:D10" or a single cell "B2") into 1-indexed bounds. */
function parseA1Range(
  ws: ExcelJS.Worksheet,
  range: string,
):
  | { ok: true; startRow: number; startCol: number; endRow: number; endCol: number }
  | { ok: false; reason: string } {
  const parts = range.split(':').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !A1_ADDR_RE.test(p))) {
    return { ok: false, reason: `Invalid range "${range}". Expected "A1" or "A1:D10".` };
  }
  const startCell = ws.getCell(parts[0]!);
  const endCell = ws.getCell(parts[1] ?? parts[0]!);
  const r1 = Number(startCell.row);
  const c1 = Number(startCell.col);
  const r2 = Number(endCell.row);
  const c2 = Number(endCell.col);
  const startRow = Math.min(r1, r2);
  const startCol = Math.min(c1, c2);
  const endRow = Math.max(r1, r2);
  const endCol = Math.max(c1, c2);
  if ((endRow - startRow + 1) * (endCol - startCol + 1) > MAX_RANGE_CELLS) {
    return {
      ok: false,
      reason: `Range "${range}" spans too many cells (max ${MAX_RANGE_CELLS}). Split into smaller ranges.`,
    };
  }
  return { ok: true, startRow, startCol, endRow, endCol };
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
  card: 'table',
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
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
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
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
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
    card: 'files',
    execute: async (input, ctx) => {
      const load = await loadWorkbookForWrite(ctx, input.path);
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
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
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
  card: 'files',
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
    card: 'files',
    defaultApproval: 'require_approval',
    execute: async (input, ctx) => {
      const load = await loadWorkbookForWrite(ctx, input.path);
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

// ─── xlsx_format_range ────────────────────────────────────────────────────────

const XlsxFontSchema = z
  .object({
    bold: z.boolean().optional().describe('Bold text.'),
    italic: z.boolean().optional().describe('Italic text.'),
    size: z.number().int().positive().optional().describe('Font size in points.'),
    color: HexColorSchema.optional().describe('Font color as a hex string, e.g. "FF0000".'),
    name: z.string().optional().describe('Font family name, e.g. "Calibri".'),
  })
  .optional()
  .describe(
    'Font properties to apply. Only the properties you provide are changed — the rest of the ' +
      'font (and everything else about the cell) is left as-is.',
  );

const XlsxFillSchema = z
  .object({
    color: HexColorSchema.describe('Background fill color as a hex string, e.g. "FFFF00".'),
  })
  .optional()
  .describe('Solid background fill color for every cell in the range.');

const XlsxBorderSchema = z
  .object({
    style: z
      .enum(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair'])
      .default('thin')
      .describe('Border line style.'),
    color: HexColorSchema.optional().describe('Border color as a hex string. Defaults to black.'),
    sides: z
      .array(z.enum(['top', 'left', 'bottom', 'right']))
      .optional()
      .describe('Which sides of each cell to apply the border to. Defaults to all four.'),
  })
  .optional()
  .describe('Simple uniform border to apply to every cell in the range.');

const XlsxAlignmentSchema = z
  .object({
    horizontal: z
      .enum(['left', 'center', 'right', 'fill', 'justify', 'centerContinuous', 'distributed'])
      .optional()
      .describe('Horizontal alignment.'),
    vertical: z
      .enum(['top', 'middle', 'bottom', 'distributed', 'justify'])
      .optional()
      .describe('Vertical alignment.'),
    wrap_text: z.boolean().optional().describe('Wrap text within the cell.'),
  })
  .optional()
  .describe('Cell content alignment.');

const XlsxFormatRangeInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  range: z
    .string()
    .min(1)
    .describe(
      'Cell range in A1 notation, e.g. "A1:D10". A single cell like "B2" is also accepted.',
    ),
  font: XlsxFontSchema,
  fill: XlsxFillSchema,
  border: XlsxBorderSchema,
  alignment: XlsxAlignmentSchema,
  num_fmt: z
    .string()
    .optional()
    .describe(
      'Excel number format code, e.g. "0.00" (2 decimals), "#,##0" (thousands separator), ' +
        '"0%" (percentage), "yyyy-mm-dd" (date).',
    ),
});

type XlsxFormatRangeOutput =
  | { ok: true; cells_formatted: number; range: string; sheet: string }
  | { ok: false; reason: string };

export const xlsxFormatRangeTool: ToolDefinition<
  typeof XlsxFormatRangeInput,
  XlsxFormatRangeOutput
> = {
  name: 'xlsx_format_range',
  description:
    'Apply formatting (font, fill color, borders, alignment, number format) to a cell range in ' +
    'an Excel worksheet. Only the properties you provide are changed — cell values, formulae, ' +
    'and any other style attribute are preserved. Use this after writing data with ' +
    'xlsx_set_range/xlsx_set_cell to make headers bold, highlight totals, or format numbers as ' +
    'currency/percentage/date.',
  inputSchema: XlsxFormatRangeInput,
  riskLevel: 'write',
  card: 'files',
  execute: async (input, ctx) => {
    const { font, fill, border, alignment } = input;
    if (!font && !fill && !border && !alignment && input.num_fmt === undefined) {
      return {
        ok: false,
        reason: 'Provide at least one of font, fill, border, alignment, or num_fmt to apply.',
      };
    }

    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    const rangeResult = parseA1Range(ws, input.range);
    if (!rangeResult.ok) return rangeResult;
    const { startRow, startCol, endRow, endCol } = rangeResult;

    const fontPatch: Partial<ExcelJS.Font> = {};
    if (font) {
      if (font.bold !== undefined) fontPatch.bold = font.bold;
      if (font.italic !== undefined) fontPatch.italic = font.italic;
      if (font.size !== undefined) fontPatch.size = font.size;
      if (font.name !== undefined) fontPatch.name = font.name;
      if (font.color !== undefined) fontPatch.color = { argb: toArgb(font.color) };
    }

    const fillValue: ExcelJS.Fill | null = fill
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(fill.color) } }
      : null;

    const borderSides: Array<'top' | 'left' | 'bottom' | 'right'> = border?.sides ?? [
      'top',
      'left',
      'bottom',
      'right',
    ];

    let cellsFormatted = 0;
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const cell = ws.getCell(r, c);

        if (font) {
          cell.font = { ...cell.font, ...fontPatch };
        }
        if (fillValue) {
          cell.fill = fillValue;
        }
        if (border) {
          const borderPatch: Partial<ExcelJS.Borders> = { ...cell.border };
          for (const side of borderSides) {
            borderPatch[side] = {
              style: border.style,
              ...(border.color ? { color: { argb: toArgb(border.color) } } : {}),
            };
          }
          cell.border = borderPatch;
        }
        if (alignment) {
          const alignPatch: Partial<ExcelJS.Alignment> = { ...cell.alignment };
          if (alignment.horizontal !== undefined) alignPatch.horizontal = alignment.horizontal;
          if (alignment.vertical !== undefined) alignPatch.vertical = alignment.vertical;
          if (alignment.wrap_text !== undefined) alignPatch.wrapText = alignment.wrap_text;
          cell.alignment = alignPatch;
        }
        if (input.num_fmt !== undefined) {
          cell.numFmt = input.num_fmt;
        }
        cellsFormatted++;
      }
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, cells_formatted: cellsFormatted, range: input.range, sheet: input.sheet };
  },
};

// ─── xlsx_insert_rows ─────────────────────────────────────────────────────────

const XlsxInsertRowsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  start_row: z
    .number()
    .int()
    .positive()
    .describe(
      '1-indexed row number where the new rows are inserted. The existing row at this position ' +
        'and every row below it shift down by the number of inserted rows.',
    ),
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .min(1)
    .describe(
      'Rows to insert, top to bottom. Each entry is an array of cell values for that row — use ' +
        'an empty array [] to insert a fully blank row. null clears a cell. Strings starting with ' +
        '"=" are formulae.',
    ),
});

type XlsxInsertRowsOutput =
  | { ok: true; rows_inserted: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxInsertRowsTool: ToolDefinition<typeof XlsxInsertRowsInput, XlsxInsertRowsOutput> =
  {
    name: 'xlsx_insert_rows',
    description:
      'Insert one or more rows at a position in a worksheet, shifting existing rows (and any ' +
      'formulae that reference them) down. Unlike xlsx_append_rows, which always adds after the ' +
      'last row, this inserts in the middle of existing data.',
    inputSchema: XlsxInsertRowsInput,
    riskLevel: 'write',
    card: 'files',
    execute: async (input, ctx) => {
      const load = await loadWorkbookForWrite(ctx, input.path);
      if (!load.ok) return load;
      const { workbook, resolvedPath } = load;

      const ws = getSheet(workbook, input.sheet);
      if (!ws) {
        return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
      }

      // Splice in blank placeholder rows first (shifts existing rows down),
      // then populate them cell-by-cell so formula strings ("=...") are
      // converted the same way as every other xlsx_* write tool.
      const blankInserts = input.rows.map(() => [] as unknown[]);
      ws.spliceRows(input.start_row, 0, ...blankInserts);

      for (let i = 0; i < input.rows.length; i++) {
        const rowVals = input.rows[i]!;
        const rowRef = ws.getRow(input.start_row + i);
        rowVals.forEach((val, colIdx) => {
          assignCellValue(rowRef.getCell(colIdx + 1), val);
        });
        rowRef.commit();
      }

      const save = await saveWorkbook(ctx, workbook, resolvedPath);
      if (!save.ok) return save;
      return { ok: true, rows_inserted: input.rows.length, sheet: input.sheet };
    },
  };

// ─── xlsx_delete_columns ──────────────────────────────────────────────────────

const XlsxDeleteColumnsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  start_column: ColumnLetterSchema.describe(
    'Column letter of the first column to delete, e.g. "C".',
  ),
  count: z.number().int().positive().describe('Number of columns to delete.'),
});

type XlsxDeleteColumnsOutput =
  | { ok: true; columns_deleted: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxDeleteColumnsTool: ToolDefinition<
  typeof XlsxDeleteColumnsInput,
  XlsxDeleteColumnsOutput
> = {
  name: 'xlsx_delete_columns',
  description:
    'Delete a range of columns from a worksheet. Columns to the right are shifted left. This is a ' +
    'DESTRUCTIVE operation — column data is permanently removed. Confirm the column range with ' +
    'xlsx_read first. Requires an explicit approval rule or agent-level overwrite consent.',
  inputSchema: XlsxDeleteColumnsInput,
  riskLevel: 'destructive',
  card: 'files',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    const startCol = ws.getColumn(input.start_column.toUpperCase()).number;
    const lastCol = ws.lastColumn?.number ?? 0;
    if (startCol > lastCol) {
      return {
        ok: false,
        reason: `start_column "${input.start_column}" is beyond the last column (${lastCol}) of sheet "${input.sheet}".`,
      };
    }

    ws.spliceColumns(startCol, input.count);

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, columns_deleted: input.count, sheet: input.sheet };
  },
};

// ─── xlsx_insert_columns ──────────────────────────────────────────────────────

const XlsxInsertColumnsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  start_column: ColumnLetterSchema.describe(
    'Column letter where the new columns are inserted, e.g. "C". The existing column at this ' +
      'position and every column to the right shift right by the number of inserted columns.',
  ),
  columns: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .min(1)
    .describe(
      'Columns to insert, left to right. Each entry is an array of cell values top-to-bottom for ' +
        'that column — use an empty array [] to insert a fully blank column. null clears a cell. ' +
        'Strings starting with "=" are formulae.',
    ),
});

type XlsxInsertColumnsOutput =
  | { ok: true; columns_inserted: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxInsertColumnsTool: ToolDefinition<
  typeof XlsxInsertColumnsInput,
  XlsxInsertColumnsOutput
> = {
  name: 'xlsx_insert_columns',
  description:
    'Insert one or more columns at a position in a worksheet, shifting existing columns (and any ' +
    'formulae that reference them) right.',
  inputSchema: XlsxInsertColumnsInput,
  riskLevel: 'write',
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    const startCol = ws.getColumn(input.start_column.toUpperCase()).number;

    // Splice in blank placeholder columns first (shifts existing columns
    // right), then populate them cell-by-cell — same reasoning as
    // xlsx_insert_rows above.
    const blankInserts = input.columns.map(() => [] as unknown[]);
    ws.spliceColumns(startCol, 0, ...blankInserts);

    for (let i = 0; i < input.columns.length; i++) {
      const colVals = input.columns[i]!;
      for (let r = 0; r < colVals.length; r++) {
        assignCellValue(ws.getCell(r + 1, startCol + i), colVals[r]!);
      }
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, columns_inserted: input.columns.length, sheet: input.sheet };
  },
};

// ─── xlsx_merge_cells ─────────────────────────────────────────────────────────

const XlsxMergeCellsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  range: z
    .string()
    .min(1)
    .describe('Cell range to merge in A1 notation, e.g. "A1:C1". Must span at least two cells.'),
});

type XlsxMergeCellsOutput =
  | { ok: true; range: string; sheet: string }
  | { ok: false; reason: string };

export const xlsxMergeCellsTool: ToolDefinition<typeof XlsxMergeCellsInput, XlsxMergeCellsOutput> =
  {
    name: 'xlsx_merge_cells',
    description:
      'Merge a rectangular cell range into a single cell (e.g. for a title spanning several ' +
      'columns). The value and style of the top-left cell are kept; the other cells in the range ' +
      'become part of the merge.',
    inputSchema: XlsxMergeCellsInput,
    riskLevel: 'write',
    card: 'files',
    execute: async (input, ctx) => {
      const load = await loadWorkbookForWrite(ctx, input.path);
      if (!load.ok) return load;
      const { workbook, resolvedPath } = load;

      const ws = getSheet(workbook, input.sheet);
      if (!ws) {
        return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
      }

      const rangeResult = parseA1Range(ws, input.range);
      if (!rangeResult.ok) return rangeResult;
      if (
        rangeResult.startRow === rangeResult.endRow &&
        rangeResult.startCol === rangeResult.endCol
      ) {
        return {
          ok: false,
          reason: `Range "${input.range}" is a single cell — merging requires at least two cells, e.g. "A1:C1".`,
        };
      }

      try {
        ws.mergeCells(input.range);
      } catch (err) {
        return { ok: false, reason: `Could not merge "${input.range}": ${(err as Error).message}` };
      }

      const save = await saveWorkbook(ctx, workbook, resolvedPath);
      if (!save.ok) return save;
      return { ok: true, range: input.range, sheet: input.sheet };
    },
  };

// ─── xlsx_unmerge_cells ───────────────────────────────────────────────────────

const XlsxUnmergeCellsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  range: z
    .string()
    .min(1)
    .describe('Previously-merged cell range to unmerge, in A1 notation, e.g. "A1:C1".'),
});

type XlsxUnmergeCellsOutput =
  | { ok: true; range: string; sheet: string }
  | { ok: false; reason: string };

export const xlsxUnmergeCellsTool: ToolDefinition<
  typeof XlsxUnmergeCellsInput,
  XlsxUnmergeCellsOutput
> = {
  name: 'xlsx_unmerge_cells',
  description: 'Undo a previous cell merge, restoring the range to independent cells.',
  inputSchema: XlsxUnmergeCellsInput,
  riskLevel: 'write',
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    const rangeResult = parseA1Range(ws, input.range);
    if (!rangeResult.ok) return rangeResult;

    try {
      ws.unMergeCells(input.range);
    } catch (err) {
      return { ok: false, reason: `Could not unmerge "${input.range}": ${(err as Error).message}` };
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, range: input.range, sheet: input.sheet };
  },
};

// ─── xlsx_set_column_widths ───────────────────────────────────────────────────

const AUTOFIT_MIN_WIDTH = 8;
const AUTOFIT_MAX_WIDTH = 60;
const AUTOFIT_PADDING = 2;

const XlsxSetColumnWidthsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  widths: z
    .array(
      z.object({
        column: ColumnLetterSchema.describe('Column letter, e.g. "A" or "AB".'),
        width: z.number().positive().describe('Column width in Excel character units.'),
      }),
    )
    .optional()
    .describe('Explicit widths to set. Combine with autofit:true to autofit other columns too.'),
  autofit: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      `Approximate autofit: sets each targeted column to its longest cell content length ` +
        `(clamped between ${AUTOFIT_MIN_WIDTH} and ${AUTOFIT_MAX_WIDTH} width units). Applied ` +
        'after widths, so it wins for any column listed in both.',
    ),
  columns: z
    .array(ColumnLetterSchema)
    .optional()
    .describe(
      'Column letters to autofit. Only used when autofit is true. Defaults to every column ' +
        'containing data in the sheet.',
    ),
});

type XlsxSetColumnWidthsOutput =
  | { ok: true; columns_set: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxSetColumnWidthsTool: ToolDefinition<
  typeof XlsxSetColumnWidthsInput,
  XlsxSetColumnWidthsOutput
> = {
  name: 'xlsx_set_column_widths',
  description:
    'Set explicit column widths and/or approximate-autofit columns to their content in an Excel ' +
    'worksheet. Autofit measures the longest displayed value in each targeted column and clamps ' +
    `the result between ${AUTOFIT_MIN_WIDTH} and ${AUTOFIT_MAX_WIDTH} width units — it is an ` +
    'approximation, not a pixel-perfect Excel autofit.',
  inputSchema: XlsxSetColumnWidthsInput,
  riskLevel: 'write',
  card: 'files',
  execute: async (input, ctx) => {
    if ((!input.widths || input.widths.length === 0) && !input.autofit) {
      return { ok: false, reason: 'Provide widths and/or set autofit:true.' };
    }

    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    let columnsSet = 0;

    if (input.widths) {
      for (const w of input.widths) {
        ws.getColumn(w.column.toUpperCase()).width = w.width;
        columnsSet++;
      }
    }

    if (input.autofit) {
      const targetCols: number[] = input.columns
        ? input.columns.map((c) => ws.getColumn(c.toUpperCase()).number)
        : Array.from({ length: ws.columnCount }, (_, i) => i + 1);

      for (const colNum of targetCols) {
        let maxLen = 0;
        ws.eachRow({ includeEmpty: false }, (row) => {
          const text = stringifyCellValue(row.getCell(colNum).value);
          if (text.length > maxLen) maxLen = text.length;
        });
        const width = Math.min(
          AUTOFIT_MAX_WIDTH,
          Math.max(AUTOFIT_MIN_WIDTH, maxLen + AUTOFIT_PADDING),
        );
        ws.getColumn(colNum).width = width;
        columnsSet++;
      }
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, columns_set: columnsSet, sheet: input.sheet };
  },
};

// ─── xlsx_freeze_panes ────────────────────────────────────────────────────────

const XlsxFreezePanesInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().min(1).describe('Worksheet name.'),
  rows: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of rows to freeze from the top. 0 = no row freeze.'),
  columns: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of columns to freeze from the left. 0 = no column freeze.'),
});

type XlsxFreezePanesOutput =
  | { ok: true; rows_frozen: number; columns_frozen: number; sheet: string }
  | { ok: false; reason: string };

export const xlsxFreezePanesTool: ToolDefinition<
  typeof XlsxFreezePanesInput,
  XlsxFreezePanesOutput
> = {
  name: 'xlsx_freeze_panes',
  description:
    'Freeze rows and/or columns in a worksheet so they stay visible while scrolling (e.g. ' +
    'freeze the header row and a label column). Pass rows:0 and columns:0 to remove an ' +
    'existing freeze.',
  inputSchema: XlsxFreezePanesInput,
  riskLevel: 'write',
  card: 'files',
  execute: async (input, ctx) => {
    const load = await loadWorkbookForWrite(ctx, input.path);
    if (!load.ok) return load;
    const { workbook, resolvedPath } = load;

    const ws = getSheet(workbook, input.sheet);
    if (!ws) {
      return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
    }

    if (input.rows === 0 && input.columns === 0) {
      ws.views = [{ state: 'normal' }];
    } else {
      ws.views = [{ state: 'frozen', xSplit: input.columns, ySplit: input.rows }];
    }

    const save = await saveWorkbook(ctx, workbook, resolvedPath);
    if (!save.ok) return save;
    return { ok: true, rows_frozen: input.rows, columns_frozen: input.columns, sheet: input.sheet };
  },
};

// ─── xlsx_find_cells ──────────────────────────────────────────────────────────

const XlsxFindCellsInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the .xlsx file.'),
  sheet: z.string().optional().describe('Worksheet name. Searches every sheet if omitted.'),
  query: z.string().min(1).describe('Value to search for.'),
  regex: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, treat query as a regular expression (case-insensitive unless case_sensitive is set).',
    ),
  case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive matching.'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(200)
    .describe('Maximum matches to return. Default and hard cap: 200.'),
});

type XlsxFindCellsOutput =
  | { ok: true; matches: Array<{ sheet: string; cell: string; value: string }>; truncated: boolean }
  | { ok: false; reason: string };

export const xlsxFindCellsTool: ToolDefinition<typeof XlsxFindCellsInput, XlsxFindCellsOutput> = {
  name: 'xlsx_find_cells',
  description:
    'Search a workbook for cells whose displayed value matches a string or regular expression. ' +
    'Formula cells are matched against their cached result. Returns cell addresses and values — ' +
    'use this to locate the cells to change before calling xlsx_set_cell/xlsx_format_range, ' +
    'instead of guessing coordinates from xlsx_read.',
  inputSchema: XlsxFindCellsInput,
  riskLevel: 'read',
  card: 'search',
  execute: async (input, ctx) => {
    const load = await loadWorkbook(ctx, input.path);
    if (!load.ok) return load;
    const { workbook } = load;

    let re: RegExp | null = null;
    if (input.regex) {
      try {
        re = new RegExp(input.query, input.case_sensitive ? '' : 'i');
      } catch (err) {
        return {
          ok: false,
          reason: `Invalid regular expression "${input.query}": ${(err as Error).message}`,
        };
      }
    }
    const needle = input.case_sensitive ? input.query : input.query.toLowerCase();

    const allMatches: Array<{ sheet: string; cell: string; value: string }> = [];
    const searchSheet = (ws: ExcelJS.Worksheet): void => {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const text = stringifyCellValue(cell.value);
          if (text === '') return;
          const isMatch = re
            ? re.test(text)
            : (input.case_sensitive ? text : text.toLowerCase()).includes(needle);
          if (isMatch) {
            allMatches.push({ sheet: ws.name, cell: cell.address, value: text });
          }
        });
      });
    };

    if (input.sheet) {
      const ws = getSheet(workbook, input.sheet);
      if (!ws) {
        return { ok: false, reason: `Sheet "${input.sheet}" not found in workbook.` };
      }
      searchSheet(ws);
    } else {
      workbook.eachSheet((ws) => searchSheet(ws));
    }

    const truncated = allMatches.length > input.max_results;
    return { ok: true, matches: allMatches.slice(0, input.max_results), truncated };
  },
};
