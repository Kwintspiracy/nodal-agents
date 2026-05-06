// @nodalai/adapter-google-docs — lifecycle tools
// docs_create, docs_get, docs_get_text

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { docs_v1 } from 'googleapis';
import { mapDocsError, DocsAdapterError } from '../errors';
import { docBodyToText } from '../helpers/doc-to-text';
import { buildAppendTextRequest } from '../helpers/batch-update';

/** Max characters allowed in get/get_text before throwing docs_document_too_large */
const CHAR_CAP = 100_000;

// ── docs_create ────────────────────────────────────────────────────────────

const CreateDocInput = z.object({
  title: z.string().describe('Title for the new document.'),
  content: z
    .string()
    .optional()
    .describe('Optional initial text content to insert into the document body.'),
});

export type CreateDocOutput = {
  documentId: string;
  title: string;
  url: string;
};

export function createCreateDocTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof CreateDocInput, CreateDocOutput> {
  return {
    name: 'docs_create',
    description:
      'Create a new Google Document with the given title. Optionally provide initial text content. ' +
      "Returns the document ID and URL. The document is placed in the authenticated user's Drive root.",
    inputSchema: CreateDocInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await docs.documents.create({
          requestBody: { title: input.title },
        });
        const documentId = res.data.documentId ?? '';
        const title = res.data.title ?? input.title;

        // Insert initial content if provided
        if (input.content && input.content.length > 0) {
          const text = input.content.endsWith('\n') ? input.content : input.content + '\n';
          await docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [buildAppendTextRequest(text)],
            },
          });
        }

        return {
          documentId,
          title,
          url: `https://docs.google.com/document/d/${documentId}/edit`,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_get ───────────────────────────────────────────────────────────────

const GetDocInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
});

export type DocHeader = {
  headerId: string;
  text: string;
};

export type DocFooter = {
  footerId: string;
  text: string;
};

export type GetDocOutput = {
  documentId: string;
  title: string;
  body: docs_v1.Schema$Body;
  headers: DocHeader[];
  footers: DocFooter[];
  revisionId: string;
};

export function createGetDocTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof GetDocInput, GetDocOutput> {
  return {
    name: 'docs_get',
    description:
      'Get the full structured content of a Google Document as JSON: title, body (with all paragraphs, ' +
      'tables, and structural elements), plus headers and footers. ' +
      'Capped at 100,000 characters of body text — use docs_get_text for plain text extraction.',
    inputSchema: GetDocInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await docs.documents.get({
          documentId: input.document_id,
        });
        const doc = res.data;

        // Check text length cap
        if (doc.body) {
          const text = docBodyToText(doc.body);
          if (text.length > CHAR_CAP) {
            throw new DocsAdapterError(
              'docs_document_too_large',
              `Document body contains ${text.length} characters which exceeds the ${CHAR_CAP}-character cap.`,
            );
          }
        }

        // Extract headers
        const headers: DocHeader[] = Object.entries(doc.headers ?? {}).map(([id, h]) => ({
          headerId: id,
          text: h.content ? docBodyToText({ content: h.content }) : '',
        }));

        // Extract footers
        const footers: DocFooter[] = Object.entries(doc.footers ?? {}).map(([id, f]) => ({
          footerId: id,
          text: f.content ? docBodyToText({ content: f.content }) : '',
        }));

        return {
          documentId: doc.documentId ?? input.document_id,
          title: doc.title ?? '',
          body: doc.body ?? {},
          headers,
          footers,
          revisionId: doc.revisionId ?? '',
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_get_text ──────────────────────────────────────────────────────────

const GetDocTextInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
});

export type GetDocTextOutput = {
  documentId: string;
  title: string;
  text: string;
  charCount: number;
};

export function createGetDocTextTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof GetDocTextInput, GetDocTextOutput> {
  return {
    name: 'docs_get_text',
    description:
      'Get the plain text content of a Google Document. Parses the document body, ' +
      'joining all paragraph runs, handling tables (tab-separated cells), and headings. ' +
      'Capped at 100,000 characters — throws docs_document_too_large if exceeded.',
    inputSchema: GetDocTextInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await docs.documents.get({
          documentId: input.document_id,
        });
        const doc = res.data;
        const text = doc.body ? docBodyToText(doc.body) : '';

        if (text.length > CHAR_CAP) {
          throw new DocsAdapterError(
            'docs_document_too_large',
            `Document contains ${text.length} characters which exceeds the ${CHAR_CAP}-character cap.`,
          );
        }

        return {
          documentId: doc.documentId ?? input.document_id,
          title: doc.title ?? '',
          text,
          charCount: text.length,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}
