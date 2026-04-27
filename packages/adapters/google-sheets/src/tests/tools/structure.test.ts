// @nodalai/adapter-google-sheets — structure tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  createGetMetadataTool,
  createCreateSpreadsheetTool,
  createAddSheetTool,
  createDeleteSheetTool,
  createDuplicateSheetTool,
  createRenameSheetTool,
} from '../../tools/structure.js';

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

// ── sheets_get_metadata ────────────────────────────────────────────────────

describe('sheets_get_metadata', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('returns spreadsheet metadata with sheet tabs', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        spreadsheetId: 'ss-123',
        properties: { title: 'My Spreadsheet' },
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/ss-123/edit',
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: 'Sheet1',
              index: 0,
              hidden: false,
              gridProperties: { rowCount: 1000, columnCount: 26 },
            },
          },
          {
            properties: {
              sheetId: 1,
              title: 'Data',
              index: 1,
              hidden: false,
              gridProperties: { rowCount: 500, columnCount: 10 },
            },
          },
        ],
        namedRanges: [],
      },
    });

    const tool = createGetMetadataTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'ss-123' }, {} as never);
    expect(result.spreadsheetId).toBe('ss-123');
    expect(result.title).toBe('My Spreadsheet');
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0]?.title).toBe('Sheet1');
    expect(result.sheets[0]?.rowCount).toBe(1000);
    expect(result.sheets[1]?.title).toBe('Data');
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createGetMetadataTool(sheets);
    await expect(tool.execute({ spreadsheet_id: 'abc' }, {} as never)).rejects.toMatchObject({
      code: 'sheets_unauthorized',
    });
  });

  it('maps 404 to sheets_not_found', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });
    const tool = createGetMetadataTool(sheets);
    await expect(tool.execute({ spreadsheet_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'sheets_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetMetadataTool(sheets).riskLevel).toBe('read');
  });
});

// ── sheets_create_spreadsheet ──────────────────────────────────────────────

describe('sheets_create_spreadsheet', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('creates a spreadsheet and returns id and url', async () => {
    (sheets.spreadsheets.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        spreadsheetId: 'new-ss-id',
        properties: { title: 'New Sheet' },
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-ss-id/edit',
        sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
      },
    });

    const tool = createCreateSpreadsheetTool(sheets);
    const result = await tool.execute({ title: 'New Sheet' }, {} as never);
    expect(result.spreadsheetId).toBe('new-ss-id');
    expect(result.title).toBe('New Sheet');
    expect(result.url).toContain('new-ss-id');
    expect(result.firstSheetId).toBe(0);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createCreateSpreadsheetTool(sheets);
    await expect(tool.execute({ title: 'Test' }, {} as never)).rejects.toMatchObject({
      code: 'sheets_unauthorized',
    });
  });

  it('has riskLevel write', () => {
    expect(createCreateSpreadsheetTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_add_sheet ────────────────────────────────────────────────────────

describe('sheets_add_sheet', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('adds a sheet tab and returns properties', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        replies: [{ addSheet: { properties: { sheetId: 42, title: 'NewTab', index: 1 } } }],
      },
    });

    const tool = createAddSheetTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc', title: 'NewTab' }, {} as never);
    expect(result.sheetId).toBe(42);
    expect(result.title).toBe('NewTab');
  });

  it('maps 403 to sheets_forbidden', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });
    const tool = createAddSheetTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', title: 'Tab' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_forbidden' });
  });

  it('has riskLevel write', () => {
    expect(createAddSheetTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_delete_sheet ────────────────────────────────────────────────────

describe('sheets_delete_sheet', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('deletes a sheet and returns success', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createDeleteSheetTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc', sheet_id: 42 }, {} as never);
    expect(result.deleted).toBe(true);
    expect(result.sheetId).toBe(42);
  });

  it('maps 404 to sheets_not_found', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });
    const tool = createDeleteSheetTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_id: 99 }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_not_found' });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteSheetTool(sheets).riskLevel).toBe('destructive');
  });
});

// ── sheets_duplicate_sheet ─────────────────────────────────────────────────

describe('sheets_duplicate_sheet', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('duplicates a sheet and returns new properties', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { sheets: [{ properties: { index: 0 } }, { properties: { index: 1 } }] },
    });
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        replies: [
          { duplicateSheet: { properties: { sheetId: 99, title: 'Copy of Sheet1', index: 2 } } },
        ],
      },
    });

    const tool = createDuplicateSheetTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', source_sheet_id: 0, new_sheet_name: 'Copy of Sheet1' },
      {} as never,
    );
    expect(result.sheetId).toBe(99);
    expect(result.title).toBe('Copy of Sheet1');
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createDuplicateSheetTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', source_sheet_id: 0 }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createDuplicateSheetTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_rename_sheet ────────────────────────────────────────────────────

describe('sheets_rename_sheet', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('renames a sheet and returns updated title', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createRenameSheetTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_id: 0, new_title: 'Renamed Tab' },
      {} as never,
    );
    expect(result.sheetId).toBe(0);
    expect(result.title).toBe('Renamed Tab');
  });

  it('maps 403 to sheets_forbidden', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });
    const tool = createRenameSheetTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_id: 0, new_title: 'X' }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_forbidden' });
  });

  it('has riskLevel write', () => {
    expect(createRenameSheetTool(sheets).riskLevel).toBe('write');
  });
});
