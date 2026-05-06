// @nodalai/adapter-google-docs — format tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  createFormatTextTool,
  createApplyNamedStyleTool,
  createBatchUpdateTool,
} from '../../tools/format';
import { DocsAdapterError } from '../../errors';

function makeDocs(): docs_v1.Docs {
  return {
    documents: {
      get: vi.fn(),
      create: vi.fn(),
      batchUpdate: vi.fn(),
    },
  } as unknown as docs_v1.Docs;
}

// ── docs_format_text ───────────────────────────────────────────────────────

describe('docs_format_text', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('applies bold formatting and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createFormatTextTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', start_index: 1, end_index: 10, bold: true },
      {} as never,
    );

    expect(result.formatted).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.startIndex).toBe(1);
    expect(result.endIndex).toBe(10);
  });

  it('sends updateTextStyle request with bold field', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createFormatTextTool(docs);
    await tool.execute(
      { document_id: 'doc1', start_index: 5, end_index: 15, bold: true },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.updateTextStyle.range.startIndex).toBe(5);
    expect(request.updateTextStyle.range.endIndex).toBe(15);
    expect(request.updateTextStyle.textStyle.bold).toBe(true);
    expect(request.updateTextStyle.fields).toContain('bold');
  });

  it('applies multiple formatting properties', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createFormatTextTool(docs);
    await tool.execute(
      {
        document_id: 'doc1',
        start_index: 1,
        end_index: 20,
        bold: true,
        italic: true,
        font_size_pt: 14,
      },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.updateTextStyle.textStyle.bold).toBe(true);
    expect(request.updateTextStyle.textStyle.italic).toBe(true);
    expect(request.updateTextStyle.textStyle.fontSize.magnitude).toBe(14);
    expect(request.updateTextStyle.fields).toContain('bold');
    expect(request.updateTextStyle.fields).toContain('italic');
    expect(request.updateTextStyle.fields).toContain('fontSize');
  });

  it('applies foreground color', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createFormatTextTool(docs);
    await tool.execute(
      {
        document_id: 'doc1',
        start_index: 1,
        end_index: 10,
        foreground_color: { red: 1, green: 0, blue: 0 },
      },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.updateTextStyle.textStyle.foregroundColor.color.rgbColor.red).toBe(1);
    expect(request.updateTextStyle.fields).toContain('foregroundColor');
  });

  it('throws docs_invalid_request when end_index <= start_index', async () => {
    const tool = createFormatTextTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', start_index: 10, end_index: 10, bold: true },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('throws docs_invalid_request when no formatting properties provided', async () => {
    const tool = createFormatTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 1, end_index: 10 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createFormatTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 1, end_index: 10, bold: true }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 404 to docs_not_found', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createFormatTextTool(docs);
    await expect(
      tool.execute(
        { document_id: 'missing', start_index: 1, end_index: 10, bold: true },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_not_found' });
  });

  it('rethrows DocsAdapterError without double-wrapping', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DocsAdapterError('docs_rate_limited', 'rate limited'),
    );

    const tool = createFormatTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 1, end_index: 10, bold: true }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_rate_limited' });
  });

  it('has riskLevel write', () => {
    expect(createFormatTextTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_apply_named_style ─────────────────────────────────────────────────

describe('docs_apply_named_style', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('applies named style and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createApplyNamedStyleTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', start_index: 1, end_index: 15, named_style: 'HEADING_2' },
      {} as never,
    );

    expect(result.applied).toBe(true);
    expect(result.namedStyle).toBe('HEADING_2');
    expect(result.startIndex).toBe(1);
    expect(result.endIndex).toBe(15);
  });

  it('sends updateParagraphStyle request with HEADING_1', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createApplyNamedStyleTool(docs);
    await tool.execute(
      { document_id: 'doc1', start_index: 1, end_index: 12, named_style: 'HEADING_1' },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.updateParagraphStyle.range.startIndex).toBe(1);
    expect(request.updateParagraphStyle.range.endIndex).toBe(12);
    expect(request.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_1');
    expect(request.updateParagraphStyle.fields).toBe('namedStyleType');
  });

  it('throws docs_invalid_request when end_index <= start_index', async () => {
    const tool = createApplyNamedStyleTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', start_index: 10, end_index: 5, named_style: 'HEADING_1' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createApplyNamedStyleTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', start_index: 1, end_index: 10, named_style: 'HEADING_1' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createApplyNamedStyleTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_batch_update ──────────────────────────────────────────────────────

describe('docs_batch_update', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('executes batch requests and returns reply count', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}, {}], writeControl: { requiredRevisionId: 'rev1' } },
    });

    const tool = createBatchUpdateTool(docs);
    const result = await tool.execute(
      {
        document_id: 'doc1',
        requests: [
          { insertText: { location: { index: 1 }, text: 'Hello\n' } },
          { replaceAllText: { containsText: { text: 'a', matchCase: true }, replaceText: 'b' } },
        ],
      },
      {} as never,
    );

    expect(result.repliesCount).toBe(2);
    expect(result.documentId).toBe('doc1');
  });

  it('passes raw requests unchanged to the API', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const customRequest = {
      updateDocumentStyle: {
        documentStyle: { defaultTabStop: { magnitude: 36, unit: 'PT' } },
        fields: 'defaultTabStop',
      },
    };

    const tool = createBatchUpdateTool(docs);
    await tool.execute({ document_id: 'doc1', requests: [customRequest] }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArgs[0].requestBody.requests[0]).toEqual(customRequest);
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createBatchUpdateTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', requests: [{ insertText: { location: { index: 1 }, text: 'x' } }] },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 400 to docs_invalid_request', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 400,
      message: 'Invalid request',
    });

    const tool = createBatchUpdateTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', requests: [{ invalidOp: {} }] }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('maps 429 to docs_rate_limited', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 429,
      message: 'Rate limit exceeded',
    });

    const tool = createBatchUpdateTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', requests: [{ insertText: { location: { index: 1 }, text: 'x' } }] },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_rate_limited' });
  });

  it('has riskLevel write', () => {
    expect(createBatchUpdateTool(docs).riskLevel).toBe('write');
  });
});
