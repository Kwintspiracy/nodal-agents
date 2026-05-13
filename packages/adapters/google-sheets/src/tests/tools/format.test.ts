// @nodal-agents/adapter-google-sheets — format tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  createFormatRangeTool,
  createResizeColumnsTool,
  createFreezePanesTool,
} from '../../tools/format';

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

// ── sheets_format_range ────────────────────────────────────────────────────

describe('sheets_format_range', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('applies bold formatting and returns success', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createFormatRangeTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 0,
        end_row_index: 1,
        start_column_index: 0,
        end_column_index: 5,
        bold: true,
      },
      {} as never,
    );
    expect(result.formatted).toBe(true);
    expect(result.sheetId).toBe(0);
  });

  it('passes background_color in request', async () => {
    let capturedReq: unknown;
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (params: unknown) => {
        capturedReq = params;
        return Promise.resolve({ data: {} });
      },
    );

    const tool = createFormatRangeTool(sheets);
    await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 0,
        end_row_index: 1,
        start_column_index: 0,
        end_column_index: 3,
        background_color: { red: 1, green: 0, blue: 0 },
      },
      {} as never,
    );

    const req = capturedReq as {
      requestBody: {
        requests: Array<{
          repeatCell?: { cell?: { userEnteredFormat?: { backgroundColor?: unknown } } };
        }>;
      };
    };
    const repeatCell = req.requestBody.requests[0]?.repeatCell;
    expect(repeatCell?.cell?.userEnteredFormat?.backgroundColor).toEqual({
      red: 1,
      green: 0,
      blue: 0,
    });
  });

  it('throws sheets_validation_error when no formatting provided', async () => {
    const tool = createFormatRangeTool(sheets);
    await expect(
      tool.execute(
        {
          spreadsheet_id: 'abc',
          sheet_id: 0,
          start_row_index: 0,
          end_row_index: 1,
          start_column_index: 0,
          end_column_index: 3,
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_validation_error' });
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createFormatRangeTool(sheets);
    await expect(
      tool.execute(
        {
          spreadsheet_id: 'abc',
          sheet_id: 0,
          start_row_index: 0,
          end_row_index: 1,
          start_column_index: 0,
          end_column_index: 3,
          bold: true,
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createFormatRangeTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_resize_columns ──────────────────────────────────────────────────

describe('sheets_resize_columns', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('resizes columns with fixed pixel size', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createResizeColumnsTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_column_index: 0,
        end_column_index: 3,
        pixel_size: 150,
      },
      {} as never,
    );
    expect(result.resized).toBe(true);
    expect(result.startColumnIndex).toBe(0);
    expect(result.endColumnIndex).toBe(3);
  });

  it('auto-resizes when pixel_size not provided', async () => {
    let capturedReq: unknown;
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (params: unknown) => {
        capturedReq = params;
        return Promise.resolve({ data: {} });
      },
    );

    const tool = createResizeColumnsTool(sheets);
    await tool.execute(
      { spreadsheet_id: 'abc', sheet_id: 0, start_column_index: 0, end_column_index: 5 },
      {} as never,
    );

    const req = capturedReq as {
      requestBody: { requests: Array<{ autoResizeDimensions?: unknown }> };
    };
    expect(req.requestBody.requests[0]?.autoResizeDimensions).toBeDefined();
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createResizeColumnsTool(sheets);
    await expect(
      tool.execute(
        { spreadsheet_id: 'abc', sheet_id: 0, start_column_index: 0, end_column_index: 3 },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createResizeColumnsTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_freeze_panes ────────────────────────────────────────────────────

describe('sheets_freeze_panes', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('freezes the header row', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createFreezePanesTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_id: 0, frozen_row_count: 1 },
      {} as never,
    );
    expect(result.frozenRowCount).toBe(1);
    expect(result.frozenColumnCount).toBe(0);
    expect(result.sheetId).toBe(0);
  });

  it('freezes both rows and columns', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createFreezePanesTool(sheets);
    const result = await tool.execute(
      { spreadsheet_id: 'abc', sheet_id: 0, frozen_row_count: 2, frozen_column_count: 1 },
      {} as never,
    );
    expect(result.frozenRowCount).toBe(2);
    expect(result.frozenColumnCount).toBe(1);
  });

  it('defaults to 0 rows and 0 columns', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createFreezePanesTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc', sheet_id: 0 }, {} as never);
    expect(result.frozenRowCount).toBe(0);
    expect(result.frozenColumnCount).toBe(0);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createFreezePanesTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_id: 0, frozen_row_count: 1 }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createFreezePanesTool(sheets).riskLevel).toBe('write');
  });
});
