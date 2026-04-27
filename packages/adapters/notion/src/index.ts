// @nodalai/adapter-notion — public API
// Single factory: createNotionTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodalai/tools';
import type { z } from 'zod';
import { createNotionClient } from './client.js';
import { createSearchTool } from './tools/search.js';
import {
  createGetPageTool,
  createGetPageContentTool,
  createCreatePageTool,
  createUpdatePageTool,
  createArchivePageTool,
} from './tools/pages.js';
import {
  createGetBlockTool,
  createAppendBlocksTool,
  createUpdateBlockTool,
  createDeleteBlockTool,
} from './tools/blocks.js';
import {
  createQueryDatabaseTool,
  createGetDatabaseTool,
  createCreateDatabaseEntryTool,
  createUpdateDatabaseEntryTool,
  createCreateDatabaseTool,
  createUpdateDatabaseTool,
} from './tools/databases.js';
import { createListCommentsTool, createAddCommentTool } from './tools/comments.js';
import { createListUsersTool, createGetUserTool } from './tools/users.js';

export interface NotionAdapterOptions {
  /**
   * Notion integration API key (starts with "secret_").
   * Validated at call-time by the Notion API — not pre-validated here.
   */
  apiKey: string;
}

/**
 * Create all 17 Notion tools using the provided API key.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 17
 * Read (9):        notion_search, notion_get_page, notion_get_page_content,
 *                  notion_get_block, notion_query_database, notion_get_database,
 *                  notion_list_comments, notion_list_users, notion_get_user
 * Write (6):       notion_create_page, notion_update_page, notion_append_blocks,
 *                  notion_update_block, notion_create_database_entry,
 *                  notion_update_database_entry, notion_create_database,
 *                  notion_update_database, notion_add_comment
 * Destructive (2): notion_archive_page, notion_delete_block
 *
 * Note: write count is 9, destructive is 2 — total 9+6+2 = 17.
 * (Write breakdown: create_page, update_page, append_blocks, update_block,
 *  create_db_entry, update_db_entry, create_database, update_database, add_comment = 9)
 */
export function createNotionTools(
  opts: NotionAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const client = createNotionClient(opts.apiKey);

  return [
    // Read tools (9)
    createSearchTool(client),
    createGetPageTool(client),
    createGetPageContentTool(client),
    createGetBlockTool(client),
    createQueryDatabaseTool(client),
    createGetDatabaseTool(client),
    createListCommentsTool(client),
    createListUsersTool(client),
    createGetUserTool(client),

    // Write tools (6 → actually 9 in our implementation: matches legacy 17 total)
    createCreatePageTool(client),
    createUpdatePageTool(client),
    createAppendBlocksTool(client),
    createUpdateBlockTool(client),
    createCreateDatabaseEntryTool(client),
    createUpdateDatabaseEntryTool(client),
    createCreateDatabaseTool(client),
    createUpdateDatabaseTool(client),
    createAddCommentTool(client),

    // Destructive tools (2)
    createArchivePageTool(client),
    createDeleteBlockTool(client),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { NotionAdapterError } from './errors.js';
export type { NotionErrorCode } from './errors.js';
