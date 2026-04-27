// @nodalai/adapter-google-docs — structure tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  createInsertParagraphTool,
  createInsertPageBreakTool,
  createInsertTableTool,
  createInsertImageTool,
} from '../../tools/structure.js';

function makeDocs(): docs_v1.Docs {
  return {
    documents: {
      get: vi.fn(),
      create: vi.fn(),
      batchUpdate: vi.fn(),
    },
  } as unknown as docs_v1.Docs;
}

// ── docs_insert_paragraph ──────────────────────────────────────────────────

describe('docs_insert_paragraph', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('inserts a paragraph and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertParagraphTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', text: 'New paragraph', index: 1 },
      {} as never,
    );

    expect(result.inserted).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.index).toBe(1);
  });

  it('appends trailing newline to text', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertParagraphTool(docs);
    await tool.execute({ document_id: 'doc1', text: 'No newline', index: 5 }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const insertReq = callArgs[0].requestBody.requests[0];
    expect(insertReq.insertText.text).toBe('No newline\n');
  });

  it('applies named style when provided', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}, {}] },
    });

    const tool = createInsertParagraphTool(docs);
    await tool.execute(
      { document_id: 'doc1', text: 'Heading', index: 1, named_style: 'HEADING_1' },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = callArgs[0].requestBody.requests;
    expect(requests).toHaveLength(2);
    expect(requests[0].insertText).toBeDefined();
    expect(requests[1].updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe('HEADING_1');
  });

  it('sends only one request when no named_style', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertParagraphTool(docs);
    await tool.execute({ document_id: 'doc1', text: 'Plain text', index: 1 }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = callArgs[0].requestBody.requests;
    expect(requests).toHaveLength(1);
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createInsertParagraphTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', text: 'text', index: 1 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createInsertParagraphTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_insert_page_break ─────────────────────────────────────────────────

describe('docs_insert_page_break', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('inserts a page break and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertPageBreakTool(docs);
    const result = await tool.execute({ document_id: 'doc1', index: 50 }, {} as never);

    expect(result.inserted).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.index).toBe(50);
  });

  it('calls batchUpdate with insertPageBreak request', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertPageBreakTool(docs);
    await tool.execute({ document_id: 'doc1', index: 30 }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertPageBreak?.location?.index).toBe(30);
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createInsertPageBreakTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', index: 1 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createInsertPageBreakTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_insert_table ──────────────────────────────────────────────────────

describe('docs_insert_table', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('inserts a table and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertTableTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', index: 1, rows: 3, columns: 4 },
      {} as never,
    );

    expect(result.inserted).toBe(true);
    expect(result.rows).toBe(3);
    expect(result.columns).toBe(4);
    expect(result.index).toBe(1);
  });

  it('calls batchUpdate with correct insertTable request', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertTableTool(docs);
    await tool.execute({ document_id: 'doc1', index: 5, rows: 2, columns: 3 }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertTable.location.index).toBe(5);
    expect(request.insertTable.rows).toBe(2);
    expect(request.insertTable.columns).toBe(3);
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createInsertTableTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', index: 1, rows: 2, columns: 2 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createInsertTableTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_insert_image ──────────────────────────────────────────────────────

describe('docs_insert_image', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('inserts an image and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertImageTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', image_uri: 'https://example.com/img.png', index: 10 },
      {} as never,
    );

    expect(result.inserted).toBe(true);
    expect(result.imageUri).toBe('https://example.com/img.png');
    expect(result.index).toBe(10);
  });

  it('calls batchUpdate with insertInlineImage request', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertImageTool(docs);
    await tool.execute(
      {
        document_id: 'doc1',
        image_uri: 'https://example.com/photo.jpg',
        index: 5,
        width_pt: 300,
        height_pt: 200,
      },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertInlineImage.location.index).toBe(5);
    expect(request.insertInlineImage.uri).toBe('https://example.com/photo.jpg');
    expect(request.insertInlineImage.objectSize.width.magnitude).toBe(300);
    expect(request.insertInlineImage.objectSize.height.magnitude).toBe(200);
  });

  it('inserts image without size parameters', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertImageTool(docs);
    await tool.execute(
      { document_id: 'doc1', image_uri: 'https://example.com/img.png', index: 1 },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertInlineImage.objectSize).toBeUndefined();
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createInsertImageTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', image_uri: 'https://example.com/img.png', index: 1 },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 400 to docs_invalid_request (bad image URL)', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 400,
      message: 'Invalid image URI',
    });

    const tool = createInsertImageTool(docs);
    await expect(
      tool.execute(
        { document_id: 'doc1', image_uri: 'https://example.com/img.png', index: 1 },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('has riskLevel write', () => {
    expect(createInsertImageTool(docs).riskLevel).toBe('write');
  });
});
