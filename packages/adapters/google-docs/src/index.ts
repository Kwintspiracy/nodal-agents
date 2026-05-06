// @nodalai/adapter-google-docs — public API
// Single factory: createDocsTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodalai/tools';
import type { z } from 'zod';
import { createDocsClient } from './client';

// Lifecycle (3)
import { createCreateDocTool } from './tools/lifecycle';
import { createGetDocTool } from './tools/lifecycle';
import { createGetDocTextTool } from './tools/lifecycle';

// Text (4)
import { createInsertTextTool } from './tools/text';
import { createAppendTextTool } from './tools/text';
import { createReplaceTextTool } from './tools/text';
import { createDeleteContentRangeTool } from './tools/text';

// Structure (4)
import { createInsertParagraphTool } from './tools/structure';
import { createInsertPageBreakTool } from './tools/structure';
import { createInsertTableTool } from './tools/structure';
import { createInsertImageTool } from './tools/structure';

// Format (3)
import { createFormatTextTool } from './tools/format';
import { createApplyNamedStyleTool } from './tools/format';
import { createBatchUpdateTool } from './tools/format';

export interface DocsAdapterOptions {
  /**
   * User's current OAuth2 access token for Google Docs.
   * Token refresh is the runner's responsibility — if the token expires,
   * tools throw DocsAdapterError({ code: 'docs_unauthorized' }).
   */
  accessToken: string;
}

/**
 * Create all 14 Google Docs tools using the provided OAuth access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 14
 * Read (2):        docs_get, docs_get_text
 * Write (11):      docs_create, docs_insert_text, docs_append_text, docs_replace_text,
 *                  docs_insert_paragraph, docs_insert_page_break, docs_insert_table,
 *                  docs_insert_image, docs_format_text, docs_apply_named_style,
 *                  docs_batch_update
 * Destructive (1): docs_delete_content_range
 */
export function createDocsTools(opts: DocsAdapterOptions): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const docs = createDocsClient(opts.accessToken);

  return [
    // Read tools (2)
    createGetDocTool(docs),
    createGetDocTextTool(docs),

    // Write tools (11)
    createCreateDocTool(docs),
    createInsertTextTool(docs),
    createAppendTextTool(docs),
    createReplaceTextTool(docs),
    createInsertParagraphTool(docs),
    createInsertPageBreakTool(docs),
    createInsertTableTool(docs),
    createInsertImageTool(docs),
    createFormatTextTool(docs),
    createApplyNamedStyleTool(docs),
    createBatchUpdateTool(docs),

    // Destructive tools (1)
    createDeleteContentRangeTool(docs),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { DocsAdapterError } from './errors';
export type { DocsErrorCode } from './errors';
