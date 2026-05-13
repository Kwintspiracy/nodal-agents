// @nodal-agents/adapter-google-sheets — filter and sort tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  createSetBasicFilterTool,
  createClearBasicFilterTool,
  createSortRangeTool,
} from '../../tools/filters';

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

// ── sheets_set_basic_filter ────────────────────────────────────────────────

describe('sheets_set_basic_filter', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('applies a filter and returns success', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createSetBasicFilterTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 0,
        end_row_index: 100,
        start_column_index: 0,
        end_column_index: 5,
      },
      {} as never,
    );
    expect(result.filterApplied).toBe(true);
    expect(result.sheetId).toBe(0);
  });

  it('passes correct range to API', async () => {
    let capturedReq: unknown;
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (params: unknown) => {
        capturedReq = params;
        return Promise.resolve({ data: {} });
      },
    );

    const tool = createSetBasicFilterTool(sheets);
    await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 0,
        end_row_index: 50,
        start_column_index: 0,
        end_column_index: 4,
      },
      {} as never,
    );

    const req = capturedReq as {
      requestBody: { requests: Array<{ setBasicFilter?: { filter?: { range?: unknown } } }> };
    };
    const range = req.requestBody.requests[0]?.setBasicFilter?.filter?.range as Record<
      string,
      number
    >;
    expect(range?.['sheetId']).toBe(0);
    expect(range?.['endRowIndex']).toBe(50);
    expect(range?.['endColumnIndex']).toBe(4);
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createSetBasicFilterTool(sheets);
    await expect(
      tool.execute(
        {
          spreadsheet_id: 'abc',
          sheet_id: 0,
          start_row_index: 0,
          end_row_index: 10,
          start_column_index: 0,
          end_column_index: 3,
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createSetBasicFilterTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_clear_basic_filter ──────────────────────────────────────────────

describe('sheets_clear_basic_filter', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('clears filter and returns success', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createClearBasicFilterTool(sheets);
    const result = await tool.execute({ spreadsheet_id: 'abc', sheet_id: 0 }, {} as never);
    expect(result.filterCleared).toBe(true);
    expect(result.sheetId).toBe(0);
  });

  it('passes sheetId to clearBasicFilter request', async () => {
    let capturedReq: unknown;
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (params: unknown) => {
        capturedReq = params;
        return Promise.resolve({ data: {} });
      },
    );

    const tool = createClearBasicFilterTool(sheets);
    await tool.execute({ spreadsheet_id: 'abc', sheet_id: 42 }, {} as never);

    const req = capturedReq as {
      requestBody: { requests: Array<{ clearBasicFilter?: { sheetId?: number } }> };
    };
    expect(req.requestBody.requests[0]?.clearBasicFilter?.sheetId).toBe(42);
  });

  it('maps 403 to sheets_forbidden', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });
    const tool = createClearBasicFilterTool(sheets);
    await expect(
      tool.execute({ spreadsheet_id: 'abc', sheet_id: 0 }, {} as never),
    ).rejects.toMatchObject({ code: 'sheets_forbidden' });
  });

  it('has riskLevel write', () => {
    expect(createClearBasicFilterTool(sheets).riskLevel).toBe('write');
  });
});

// ── sheets_sort_range ──────────────────────────────────────────────────────

describe('sheets_sort_range', () => {
  let sheets: sheets_v4.Sheets;
  beforeEach(() => {
    sheets = makeSheets();
  });

  it('sorts a range and returns success', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {},
    });

    const tool = createSortRangeTool(sheets);
    const result = await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 1,
        end_row_index: 100,
        start_column_index: 0,
        end_column_index: 5,
        sort_specs: [{ dimension_index: 2, sort_order: 'DESCENDING' }],
      },
      {} as never,
    );
    expect(result.sorted).toBe(true);
    expect(result.sheetId).toBe(0);
  });

  it('passes sort specs to API correctly', async () => {
    let capturedReq: unknown;
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (params: unknown) => {
        capturedReq = params;
        return Promise.resolve({ data: {} });
      },
    );

    const tool = createSortRangeTool(sheets);
    await tool.execute(
      {
        spreadsheet_id: 'abc',
        sheet_id: 0,
        start_row_index: 1,
        end_row_index: 50,
        start_column_index: 0,
        end_column_index: 4,
        sort_specs: [
          { dimension_index: 0, sort_order: 'ASCENDING' },
          { dimension_index: 2, sort_order: 'DESCENDING' },
        ],
      },
      {} as never,
    );

    const req = capturedReq as {
      requestBody: {
        requests: Array<{
          sortRange?: {
            sortSpecs?: Array<{ dimensionIndex: number; sortOrder: string }>;
          };
        }>;
      };
    };
    const sortSpecs = req.requestBody.requests[0]?.sortRange?.sortSpecs;
    expect(sortSpecs).toHaveLength(2);
    expect(sortSpecs?.[0]?.dimensionIndex).toBe(0);
    expect(sortSpecs?.[0]?.sortOrder).toBe('ASCENDING');
    expect(sortSpecs?.[1]?.dimensionIndex).toBe(2);
    expect(sortSpecs?.[1]?.sortOrder).toBe('DESCENDING');
  });

  it('maps 401 to sheets_unauthorized', async () => {
    (sheets.spreadsheets.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });
    const tool = createSortRangeTool(sheets);
    await expect(
      tool.execute(
        {
          spreadsheet_id: 'abc',
          sheet_id: 0,
          start_row_index: 1,
          end_row_index: 100,
          start_column_index: 0,
          end_column_index: 5,
          sort_specs: [{ dimension_index: 0, sort_order: 'ASCENDING' }],
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'sheets_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createSortRangeTool(sheets).riskLevel).toBe('write');
  });
});
