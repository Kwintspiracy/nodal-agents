// @nodalai/adapter-google-docs — text tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { docs_v1 } from 'googleapis';
import {
  createInsertTextTool,
  createAppendTextTool,
  createReplaceTextTool,
  createDeleteContentRangeTool,
} from '../../tools/text.js';
import { DocsAdapterError } from '../../errors.js';

function makeDocs(): docs_v1.Docs {
  return {
    documents: {
      get: vi.fn(),
      create: vi.fn(),
      batchUpdate: vi.fn(),
    },
  } as unknown as docs_v1.Docs;
}

// ── docs_insert_text ───────────────────────────────────────────────────────

describe('docs_insert_text', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('inserts text and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createInsertTextTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', text: 'Hello', index: 1 },
      {} as never,
    );

    expect(result.inserted).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.index).toBe(1);
    expect(result.charCount).toBe(5);
  });

  it('calls batchUpdate with correct insertText request', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [] },
    });

    const tool = createInsertTextTool(docs);
    await tool.execute({ document_id: 'doc1', text: 'World', index: 10 }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertText.location.index).toBe(10);
    expect(request.insertText.text).toBe('World');
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createInsertTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', text: 'Hi', index: 1 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 404 to docs_not_found', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createInsertTextTool(docs);
    await expect(
      tool.execute({ document_id: 'missing', text: 'Hi', index: 1 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_not_found' });
  });

  it('has riskLevel write', () => {
    expect(createInsertTextTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_append_text ───────────────────────────────────────────────────────

describe('docs_append_text', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('appends text and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [] },
    });

    const tool = createAppendTextTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', text: 'Appended content' },
      {} as never,
    );

    expect(result.appended).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.charCount).toBe('Appended content\n'.length);
  });

  it('adds trailing newline if not present', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [] },
    });

    const tool = createAppendTextTool(docs);
    await tool.execute({ document_id: 'doc1', text: 'No newline' }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertText.text).toBe('No newline\n');
    expect(request.insertText.endOfSegmentLocation.segmentId).toBe('');
  });

  it('preserves existing trailing newline', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [] },
    });

    const tool = createAppendTextTool(docs);
    await tool.execute({ document_id: 'doc1', text: 'With newline\n' }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.insertText.text).toBe('With newline\n');
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createAppendTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', text: 'text' }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createAppendTextTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_replace_text ──────────────────────────────────────────────────────

describe('docs_replace_text', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('returns occurrences changed', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      },
    });

    const tool = createReplaceTextTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', find: 'foo', replace: 'bar' },
      {} as never,
    );

    expect(result.occurrencesChanged).toBe(3);
    expect(result.documentId).toBe('doc1');
  });

  it('returns 0 occurrences when text not found', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{ replaceAllText: { occurrencesChanged: 0 } }] },
    });

    const tool = createReplaceTextTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', find: 'notfound', replace: 'x' },
      {} as never,
    );

    expect(result.occurrencesChanged).toBe(0);
  });

  it('uses match_case=true by default', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
    });

    const tool = createReplaceTextTool(docs);
    await tool.execute({ document_id: 'doc1', find: 'Foo', replace: 'Bar' }, {} as never);

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.replaceAllText.containsText.matchCase).toBe(true);
  });

  it('respects match_case=false', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] },
    });

    const tool = createReplaceTextTool(docs);
    await tool.execute(
      { document_id: 'doc1', find: 'foo', replace: 'bar', match_case: false },
      {} as never,
    );

    const callArgs = (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const request = callArgs[0].requestBody.requests[0];
    expect(request.replaceAllText.containsText.matchCase).toBe(false);
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createReplaceTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', find: 'x', replace: 'y' }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 403 to docs_forbidden', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createReplaceTextTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', find: 'x', replace: 'y' }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_forbidden' });
  });

  it('has riskLevel write', () => {
    expect(createReplaceTextTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_delete_content_range ─────────────────────────────────────────────

describe('docs_delete_content_range', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('deletes range and returns confirmation', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [{}] },
    });

    const tool = createDeleteContentRangeTool(docs);
    const result = await tool.execute(
      { document_id: 'doc1', start_index: 5, end_index: 20 },
      {} as never,
    );

    expect(result.deleted).toBe(true);
    expect(result.documentId).toBe('doc1');
    expect(result.startIndex).toBe(5);
    expect(result.endIndex).toBe(20);
  });

  it('throws docs_invalid_request when end_index <= start_index', async () => {
    const tool = createDeleteContentRangeTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 10, end_index: 10 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });

    await expect(
      tool.execute({ document_id: 'doc1', start_index: 15, end_index: 10 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_invalid_request' });
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createDeleteContentRangeTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 1, end_index: 5 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_unauthorized' });
  });

  it('maps 404 to docs_not_found', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createDeleteContentRangeTool(docs);
    await expect(
      tool.execute({ document_id: 'missing', start_index: 1, end_index: 5 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_not_found' });
  });

  it('rethrows DocsAdapterError without double-wrapping', async () => {
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DocsAdapterError('docs_forbidden', 'forbidden'),
    );

    const tool = createDeleteContentRangeTool(docs);
    await expect(
      tool.execute({ document_id: 'doc1', start_index: 1, end_index: 5 }, {} as never),
    ).rejects.toMatchObject({ code: 'docs_forbidden' });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteContentRangeTool(docs).riskLevel).toBe('destructive');
  });
});
