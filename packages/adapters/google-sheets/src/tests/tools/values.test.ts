// @nodal-agents/adapter-google-sheets — values tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  createReadRangeTool,
  createReadAllTool,
  createBatchReadRangesTool,
  createWriteRangeTool,
  createAppendRowTool,
  createClearRangeTool,
  createBatchUpdateValuesTool,
  createFindRowsTool,
} from '../../tools/values';
import { SheetsAdapterError } from '../../errors';

function makeSheets(): sheets_v4.Sheets {
  return {
    spreadsheets: {
      get: vi.fn(),
      create: vi.fn(),
      batchUpdate: vi.fn(),
      values: {
        get: vi.fn(),
        update: vi.fn(),
        append: vi.fn(),
        clear: vi.fn(),
        batchGet: vi.fn(),
        batchUpdate: vi.fn(),
      },
    },
  } as unknown as sheets_v4.Sheets;
}

// ── sheets_read_range ──────────────────────────────────────────────────────

describe('sheets_read_range', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('returns 2D array of values', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        range: 'Sheet1!A1:C3',
        values: [
          ['Name', 'Score', 'Grade'],
          ['Alice', '95', 'A'],
          ['Bob', '87', 'B'],
        ],
      },
    });

    const tool = createReadRangeTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', range: 'Sheet1!A1:C3' },
      {} as never,
    );
    expect(result.rows).toBe(3);
    expect(result.cols).toBe(3);
    expect(result.values[0]).toEqual(['Name', 'Score', 'Grade']);
  });

  it('returns empty grid for empty range', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { range: 'Sheet1!A1:C3', values: null },
    });
    const tool = createReadRangeTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', range: 'Sheet1!A1:C3' },
      {} as never,
    );
    expect(result.rows).toBe(0);
    expect(result.values).toHaveLength(0);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createReadRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'A1:B2' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('maps 404 to sheets_not_found', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });
    const tool = createReadRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'A1:B2' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_not_found' });
  });

  it('throws sheets_invalid_range for empty range string', async () => {
    const tool = createReadRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: '' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_invalid_range' });
  });

  it('throws sheets_range_too_large when response exceeds cap', async () => {
    const bigGrid = Array.from({ length: 10001 }, (_, i) => [`row${i}`]);
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { range: 'Sheet1!A1:A10001', values: bigGrid },
    });
    const tool = createReadRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'Sheet1!A1:A10001' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_range_too_large' });
  });

  it('has riskLevel read', () => {
    expect(createReadRangeTool(sheets).riskLevel).toBe('read');
  });
});

// ── sheets_read_all ────────────────────────────────────────────────────────

describe('sheets_read_all', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('returns headers and data rows', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        values: [
          ['Name', 'Score'],
          ['Alice', '95'],
          ['Bob', '87'],
        ],
      },
    });
    const tool = createReadAllTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc', sheet_name: 'Sheet1' }, {} as never);
    expect(result.headers).toEqual(['Name', 'Score']);
    expect(result.rowCount).toBe(2);
    expect(result.sheetName).toBe('Sheet1');
  });

  it('resolves first sheet name when sheet_name not provided', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { sheets: [{ properties: { title: 'Data' } }] },
    });
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        values: [
          ['A', 'B'],
          ['1', '2'],
        ],
      },
    });
    const tool = createReadAllTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc' }, {} as never);
    expect(result.sheetName).toBe('Data');
    expect(result.headers).toEqual(['A', 'B']);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createReadAllTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_name: 'Sheet1' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('throws sheets_range_too_large when row count exceeds cap', async () => {
    const bigGrid = Array.from({ length: 10001 }, (_, i) => [`row${i}`]);
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: bigGrid },
    });
    const tool = createReadAllTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_name: 'Sheet1' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_range_too_large' });
  });

  it('has riskLevel read', () => {
    expect(createReadAllTool(sheets).riskLevel).toBe('read');
  });
});

// ── sheets_batch_read_ranges ───────────────────────────────────────────────

describe('sheets_batch_read_ranges', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('returns results for each range', async () => {
    (sheets.spreadsheets.values.batchGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        valueRanges: [
          {
            range: 'Sheet1!A1:B2',
            values: [
              ['x', 'y'],
              ['1', '2'],
            ],
          },
          { range: 'Sheet2!A1:A3', values: [['a'], ['b'], ['c']] },
        ],
      },
    });
    const tool = createBatchReadRangesTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', ranges: ['Sheet1!A1:B2', 'Sheet2!A1:A3'] },
      {} as never,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.rows).toBe(2);
    expect(result.results[1]?.rows).toBe(3);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.batchGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createBatchReadRangesTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', ranges: ['A1:B2'] }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel read', () => {
    expect(createBatchReadRangesTool(sheets).riskLevel).toBe('read');
  });
});

// ── sheets_write_range ─────────────────────────────────────────────────────

describe('sheets_write_range', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('writes values and returns update summary', async () => {
    (sheets.spreadsheets.values.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { updatedRange: 'Sheet1!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 },
    });
    const tool = createWriteRangeTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        range: 'Sheet1!A1',
        values: [
          ['Name', 'Score'],
          ['Alice', 95],
        ],
      },
      {} as never,
    );
    expect(result.updatedCells).toBe(4);
    expect(result.updatedRows).toBe(2);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createWriteRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'A1', values: [['x']] }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('throws sheets_invalid_range for invalid range', async () => {
    const tool = createWriteRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: '', values: [['x']] }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_invalid_range' });
  });

  it('has riskLevel write', () => {
    expect(createWriteRangeTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_append_row ──────────────────────────────────────────────────────

describe('sheets_append_row', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('appends rows and returns update summary', async () => {
    (sheets.spreadsheets.values.append as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { updates: { updatedRange: 'Sheet1!A5:B5', updatedRows: 1, updatedCells: 2 } },
    });
    const tool = createAppendRowTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', range: 'Sheet1', values: [['Alice', 95]] },
      {} as never,
    );
    expect(result.updatedRows).toBe(1);
    expect(result.updatedCells).toBe(2);
  });

  it('maps 403 to sheets_forbidden', async () => {
    (sheets.spreadsheets.values.append as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });
    const tool = createAppendRowTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'Sheet1', values: [['x']] }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_forbidden' });
  });

  it('has riskLevel write', () => {
    expect(createAppendRowTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_clear_range ─────────────────────────────────────────────────────

describe('sheets_clear_range', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('clears a range and returns cleared range', async () => {
    (sheets.spreadsheets.values.clear as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { clearedRange: 'Sheet1!A2:Z100' },
    });
    const tool = createClearRangeTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', range: 'Sheet1!A2:Z100' },
      {} as never,
    );
    expect(result.clearedRange).toBe('Sheet1!A2:Z100');
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.clear as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createClearRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'A1:B2' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createClearRangeTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_batch_update_values ─────────────────────────────────────────────

describe('sheets_batch_update_values', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('updates multiple ranges and returns summary', async () => {
    (sheets.spreadsheets.values.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        totalUpdatedCells: 6,
        totalUpdatedRows: 3,
        responses: [
          { updatedRange: 'Sheet1!A1:B2', updatedCells: 4 },
          { updatedRange: 'Sheet2!A1', updatedCells: 2 },
        ],
      },
    });
    const tool = createBatchUpdateValuesTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        updates: [
          {
            range: 'Sheet1!A1',
            values: [
              ['a', 'b'],
              ['c', 'd'],
            ],
          },
          { range: 'Sheet2!A1', values: [['x', 'y']] },
        ],
      },
      {} as never,
    );
    expect(result.totalUpdatedCells).toBe(6);
    expect(result.responses).toHaveLength(2);
  });

  it('maps 429 to sheets_rate_limited', async () => {
    (sheets.spreadsheets.values.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 429,
      message: 'Rate limit',
    });
    const tool = createBatchUpdateValuesTool(sheets);
    await expect(
      tool.execute(
        { spreadsheet_id: 'abc', updates: [{ range: 'A1', values: [['x']] }] },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_rate_limited' });
  });

  it('has riskLevel write', () => {
    expect(createBatchUpdateValuesTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_find_rows ───────────────────────────────────────────────────────

describe('sheets_find_rows', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  const mockData = [
    ['Name', 'Status', 'Score'],
    ['Alice', 'active', '95'],
    ['Bob', 'inactive', '87'],
    ['Carol', 'active', '92'],
  ];

  it('finds rows by equals', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: mockData },
    });
    const tool = createFindRowsTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status', equals: 'active' },
      {} as never,
    );
    expect(result.rowCount).toBe(2);
    expect(result.rows[0]?.['Name']).toBe('Alice');
    expect(result.rows[1]?.['Name']).toBe('Carol');
  });

  it('finds rows by contains', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: mockData },
    });
    const tool = createFindRowsTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status', contains: 'act' },
      {} as never,
    );
    expect(result.rowCount).toBe(3); // active, inactive, active all contain 'act'
  });

  it('throws sheets_validation_error when neither equals nor contains provided', async () => {
    const tool = createFindRowsTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_validation_error' });
  });

  it('throws sheets_validation_error when both equals and contains provided', async () => {
    const tool = createFindRowsTool(sheets);
    await expect(
      tool.execute(
        {
          spreadsheet_id: 'abc',
          sheet_name: 'Sheet1',
          column: 'Status',
          equals: 'active',
          contains: 'act',
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_validation_error' });
  });

  it('throws sheets_validation_error for unknown column', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: mockData },
    });
    const tool = createFindRowsTool(sheets);
    await expect(
      tool.execute(
        { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'NonExistent', equals: 'x' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_validation_error' });
  });

  it('includes _row numbers in results', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: mockData },
    });
    const tool = createFindRowsTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status', equals: 'active' },
      {} as never,
    );
    expect(result.rows[0]?.['_row']).toBe(2); // Alice is row 2 (header=1, Alice=2)
    expect(result.rows[1]?.['_row']).toBe(4); // Carol is row 4
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createFindRowsTool(sheets);
    await expect(
      tool.execute(
        { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status', equals: 'x' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('resolves first sheet name when sheet_name not provided', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { sheets: [{ properties: { title: 'Data' } }] },
    });
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: mockData },
    });
    const tool = createFindRowsTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', column: 'Status', equals: 'active' },
      {} as never,
    );
    expect(result.rowCount).toBe(2);
  });

  it('returns empty results for empty sheet', async () => {
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { values: [] },
    });
    const tool = createFindRowsTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_name: 'Sheet1', column: 'Status', equals: 'active' },
      {} as never,
    );
    expect(result.rowCount).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('has riskLevel read', () => {
    expect(createFindRowsTool(sheets).riskLevel).toBe('read');
  });
});

// ── SheetsAdapterError passthrough ────────────────────────────────────────

describe('SheetsAdapterError passthrough', () => {
  it('rethrows SheetsAdapterError without double-wrapping', async () => {
    const sheets = makeSheets();
    (sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SheetsAdapterError('sheets_range_too_large', 'too large'),
    );
    const tool = createReadRangeTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', range: 'A1:B2' }, {} as never),
    ).rejects.toMatchObject({
      code: 'sheets_range_too_large',
    });
  });
});
