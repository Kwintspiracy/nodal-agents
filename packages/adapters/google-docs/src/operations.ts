// Google Docs adapter operation descriptors.
// Each slug MUST match the tool name produced by createDocsTools() exactly.
// Risk classification:
//   read        — docs_get, docs_get_text
//   write       — docs_create, docs_insert_text, docs_append_text, docs_replace_text,
//                 docs_insert_paragraph, docs_insert_page_break, docs_insert_table,
//                 docs_insert_image, docs_format_text, docs_apply_named_style,
//                 docs_batch_update
//   destructive — docs_delete_content_range

import type { OperationDescriptor } from '@nodalai/shared';

export const DOCS_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (2) ────────────────────────────────────────────────────────────────
  {
    slug: 'docs_get',
    name: 'Get document',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve full document structure and content.',
  },
  {
    slug: 'docs_get_text',
    name: 'Get document text',
    risk: 'read',
    requiresApproval: false,
    description: 'Extract plain text from a Google Doc.',
  },

  // ─── Write (11) ──────────────────────────────────────────────────────────────
  {
    slug: 'docs_create',
    name: 'Create document',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new Google Docs document.',
  },
  {
    slug: 'docs_insert_text',
    name: 'Insert text',
    risk: 'write',
    requiresApproval: false,
    description: 'Insert text at a specific index in the document.',
  },
  {
    slug: 'docs_append_text',
    name: 'Append text',
    risk: 'write',
    requiresApproval: false,
    description: 'Append text at the end of the document.',
  },
  {
    slug: 'docs_replace_text',
    name: 'Replace text',
    risk: 'write',
    requiresApproval: false,
    description: 'Find and replace text throughout the document.',
  },
  {
    slug: 'docs_insert_paragraph',
    name: 'Insert paragraph',
    risk: 'write',
    requiresApproval: false,
    description: 'Insert a new paragraph at a given index.',
  },
  {
    slug: 'docs_insert_page_break',
    name: 'Insert page break',
    risk: 'write',
    requiresApproval: false,
    description: 'Insert a page break at a given index.',
  },
  {
    slug: 'docs_insert_table',
    name: 'Insert table',
    risk: 'write',
    requiresApproval: false,
    description: 'Insert a table with specified rows and columns.',
  },
  {
    slug: 'docs_insert_image',
    name: 'Insert image',
    risk: 'write',
    requiresApproval: false,
    description: 'Insert an image from a URL into the document.',
  },
  {
    slug: 'docs_format_text',
    name: 'Format text',
    risk: 'write',
    requiresApproval: false,
    description: 'Apply text formatting (bold, italic, color) to a range.',
  },
  {
    slug: 'docs_apply_named_style',
    name: 'Apply named style',
    risk: 'write',
    requiresApproval: false,
    description: 'Apply a heading or paragraph style to a range.',
  },
  {
    slug: 'docs_batch_update',
    name: 'Batch update',
    risk: 'write',
    requiresApproval: false,
    description: 'Send multiple document update requests in a single API call.',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'docs_delete_content_range',
    name: 'Delete content range',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Delete a range of content from the document (irreversible).',
  },
];
