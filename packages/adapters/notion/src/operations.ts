// Notion adapter operation descriptors.
// Each slug MUST match the tool name produced by createNotionTools() exactly.
// Risk classification:
//   read        — notion_search, notion_get_*, notion_query_*, notion_list_*
//   write       — notion_create_*, notion_update_*, notion_append_*, notion_add_*
//   destructive — notion_archive_*, notion_delete_*

import type { OperationDescriptor } from '@nodalai/shared';

export const NOTION_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (9) ────────────────────────────────────────────────────────────────
  {
    slug: 'notion_search',
    name: 'Search',
    risk: 'read',
    requiresApproval: false,
    description: 'Search pages and databases by title.',
  },
  {
    slug: 'notion_get_page',
    name: 'Get page',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve page properties by ID.',
  },
  {
    slug: 'notion_get_page_content',
    name: 'Get page content',
    risk: 'read',
    requiresApproval: false,
    description: 'Read all blocks inside a page.',
  },
  {
    slug: 'notion_get_block',
    name: 'Get block',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve a single block and its children.',
  },
  {
    slug: 'notion_query_database',
    name: 'Query database',
    risk: 'read',
    requiresApproval: false,
    description: 'Filter and sort rows in a Notion database.',
  },
  {
    slug: 'notion_get_database',
    name: 'Get database',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve database schema and properties.',
  },
  {
    slug: 'notion_list_comments',
    name: 'List comments',
    risk: 'read',
    requiresApproval: false,
    description: 'List all comments on a page or block.',
  },
  {
    slug: 'notion_list_users',
    name: 'List users',
    risk: 'read',
    requiresApproval: false,
    description: 'List workspace members.',
  },
  {
    slug: 'notion_get_user',
    name: 'Get user',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve a workspace member by ID.',
  },

  // ─── Write (9) ───────────────────────────────────────────────────────────────
  {
    slug: 'notion_create_page',
    name: 'Create page',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new page inside a parent page or database.',
  },
  {
    slug: 'notion_update_page',
    name: 'Update page',
    risk: 'write',
    requiresApproval: false,
    description: 'Update page properties.',
  },
  {
    slug: 'notion_append_blocks',
    name: 'Append blocks',
    risk: 'write',
    requiresApproval: false,
    description: 'Append content blocks to a page or block.',
  },
  {
    slug: 'notion_update_block',
    name: 'Update block',
    risk: 'write',
    requiresApproval: false,
    description: 'Update an existing block content.',
  },
  {
    slug: 'notion_create_database_entry',
    name: 'Create database entry',
    risk: 'write',
    requiresApproval: false,
    description: 'Add a new row to a Notion database.',
  },
  {
    slug: 'notion_update_database_entry',
    name: 'Update database entry',
    risk: 'write',
    requiresApproval: false,
    description: 'Update properties on an existing database row.',
  },
  {
    slug: 'notion_create_database',
    name: 'Create database',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new database inside a parent page.',
  },
  {
    slug: 'notion_update_database',
    name: 'Update database',
    risk: 'write',
    requiresApproval: false,
    description: 'Update database title or property schema.',
  },
  {
    slug: 'notion_add_comment',
    name: 'Add comment',
    risk: 'write',
    requiresApproval: false,
    description: 'Add a comment to a page or block.',
  },

  // ─── Destructive (2) ─────────────────────────────────────────────────────────
  {
    slug: 'notion_archive_page',
    name: 'Archive page',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Archive (soft-delete) a page.',
  },
  {
    slug: 'notion_delete_block',
    name: 'Delete block',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a block.',
  },
];
