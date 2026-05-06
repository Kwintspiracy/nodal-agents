// @nodalai/adapter-google-docs — lifecycle tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { createCreateDocTool, createGetDocTool, createGetDocTextTool } from '../../tools/lifecycle';
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

// ── docs_create ────────────────────────────────────────────────────────────

describe('docs_create', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('creates a document and returns id + url', async () => {
    (docs.documents.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { documentId: 'doc123', title: 'My Doc' },
    });
    (docs.documents.batchUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { replies: [] },
    });

    const tool = createCreateDocTool(docs);
    const result = await tool.execute({ title: 'My Doc', content: 'Hello' }, {} as never);

    expect(result.documentId).toBe('doc123');
    expect(result.title).toBe('My Doc');
    expect(result.url).toBe('https://docs.google.com/document/d/doc123/edit');
  });

  it('creates a document without content (no batchUpdate call)', async () => {
    (docs.documents.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { documentId: 'doc456', title: 'Empty Doc' },
    });

    const tool = createCreateDocTool(docs);
    const result = await tool.execute({ title: 'Empty Doc' }, {} as never);

    expect(result.documentId).toBe('doc456');
    expect(docs.documents.batchUpdate).not.toHaveBeenCalled();
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createCreateDocTool(docs);
    await expect(tool.execute({ title: 'Doc' }, {} as never)).rejects.toMatchObject({
      code: 'docs_unauthorized',
    });
  });

  it('maps 403 to docs_forbidden', async () => {
    (docs.documents.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createCreateDocTool(docs);
    await expect(tool.execute({ title: 'Doc' }, {} as never)).rejects.toMatchObject({
      code: 'docs_forbidden',
    });
  });

  it('has riskLevel write', () => {
    expect(createCreateDocTool(docs).riskLevel).toBe('write');
  });
});

// ── docs_get ───────────────────────────────────────────────────────────────

describe('docs_get', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  const mockDoc: docs_v1.Schema$Document = {
    documentId: 'docABC',
    title: 'Test Document',
    revisionId: 'rev1',
    body: {
      content: [
        {
          paragraph: {
            elements: [{ textRun: { content: 'Hello world\n' } }],
          },
        },
      ],
    },
    headers: {},
    footers: {},
  };

  it('returns structured document with body, headers, footers', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: mockDoc });

    const tool = createGetDocTool(docs);
    const result = await tool.execute({ document_id: 'docABC' }, {} as never);

    expect(result.documentId).toBe('docABC');
    expect(result.title).toBe('Test Document');
    expect(result.revisionId).toBe('rev1');
    expect(result.headers).toEqual([]);
    expect(result.footers).toEqual([]);
    expect(result.body).toBeDefined();
  });

  it('throws docs_document_too_large when text exceeds cap', async () => {
    const bigText = 'a'.repeat(100_001) + '\n';
    (docs.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        documentId: 'bigDoc',
        title: 'Big',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: bigText } }],
              },
            },
          ],
        },
      },
    });

    const tool = createGetDocTool(docs);
    await expect(tool.execute({ document_id: 'bigDoc' }, {} as never)).rejects.toMatchObject({
      code: 'docs_document_too_large',
    });
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createGetDocTool(docs);
    await expect(tool.execute({ document_id: 'docABC' }, {} as never)).rejects.toMatchObject({
      code: 'docs_unauthorized',
    });
  });

  it('maps 404 to docs_not_found', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetDocTool(docs);
    await expect(tool.execute({ document_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'docs_not_found',
    });
  });

  it('rethrows DocsAdapterError without double-wrapping', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DocsAdapterError('docs_document_too_large', 'too large'),
    );

    const tool = createGetDocTool(docs);
    await expect(tool.execute({ document_id: 'docABC' }, {} as never)).rejects.toMatchObject({
      code: 'docs_document_too_large',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetDocTool(docs).riskLevel).toBe('read');
  });
});

// ── docs_get_text ──────────────────────────────────────────────────────────

describe('docs_get_text', () => {
  let docs: docs_v1.Docs;
  beforeEach(() => {
    docs = makeDocs();
  });

  it('returns plain text from document body', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        documentId: 'doc1',
        title: 'My Doc',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'Hello world\n' } }],
              },
            },
            {
              paragraph: {
                elements: [{ textRun: { content: 'Second paragraph\n' } }],
              },
            },
          ],
        },
      },
    });

    const tool = createGetDocTextTool(docs);
    const result = await tool.execute({ document_id: 'doc1' }, {} as never);

    expect(result.documentId).toBe('doc1');
    expect(result.title).toBe('My Doc');
    expect(result.text).toBe('Hello world\nSecond paragraph\n');
    expect(result.charCount).toBe(result.text.length);
  });

  it('returns empty text for document with no body content', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        documentId: 'emptyDoc',
        title: 'Empty',
      },
    });

    const tool = createGetDocTextTool(docs);
    const result = await tool.execute({ document_id: 'emptyDoc' }, {} as never);

    expect(result.text).toBe('');
    expect(result.charCount).toBe(0);
  });

  it('throws docs_document_too_large when text exceeds 100k chars', async () => {
    const bigText = 'x'.repeat(100_001) + '\n';
    (docs.documents.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        documentId: 'big',
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: bigText } }] } }],
        },
      },
    });

    const tool = createGetDocTextTool(docs);
    await expect(tool.execute({ document_id: 'big' }, {} as never)).rejects.toMatchObject({
      code: 'docs_document_too_large',
    });
  });

  it('maps 401 to docs_unauthorized', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createGetDocTextTool(docs);
    await expect(tool.execute({ document_id: 'doc1' }, {} as never)).rejects.toMatchObject({
      code: 'docs_unauthorized',
    });
  });

  it('maps 404 to docs_not_found', async () => {
    (docs.documents.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetDocTextTool(docs);
    await expect(tool.execute({ document_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'docs_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetDocTextTool(docs).riskLevel).toBe('read');
  });
});
