// @nodalai/adapter-notion — page tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors';
import {
  extractTitle,
  extractPropertyValue,
  chunkRichText,
  buildNotionProperty,
} from '../helpers/property-coerce';
import { paginateBlockChildren } from '../helpers/pagination';
import { blocksToText } from '../helpers/block-to-text';

// ── notion_get_page ───────────────────────────────────────────────────────────

const GetPageInput = z.object({
  page_id: z.string().describe('Notion page ID (UUID or dashed UUID).'),
});

export type GetPageOutput = {
  id: string;
  title: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, string>;
};

export function createGetPageTool(
  client: Client,
): ToolDefinition<typeof GetPageInput, GetPageOutput> {
  return {
    name: 'notion_get_page',
    description:
      'Retrieve a Notion page by its ID. Returns the page title and a summary of its properties.',
    inputSchema: GetPageInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const page = await client.pages.retrieve({ page_id: input.page_id });
        if (!('properties' in page)) {
          throw mapNotionError(new Error('notion_not_found'));
        }

        const title = extractTitle(
          page as { properties?: Record<string, { type: string; [k: string]: unknown }> },
        );
        const url = 'url' in page ? (page.url as string) : '';

        // Summarize non-title properties
        const properties: Record<string, string> = {};
        for (const [name, prop] of Object.entries(page.properties)) {
          const typedProp = prop as { type: string; [k: string]: unknown };
          if (typedProp.type === 'title') continue;
          const val = extractPropertyValue(typedProp);
          if (val) properties[name] = val.slice(0, 200);
        }

        return {
          id: page.id,
          title,
          url,
          created_time: 'created_time' in page ? String(page.created_time) : '',
          last_edited_time: 'last_edited_time' in page ? String(page.last_edited_time) : '',
          properties,
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_get_page_content ───────────────────────────────────────────────────

const GetPageContentInput = z.object({
  page_id: z.string().describe('Notion page or block ID whose content to read.'),
  max_blocks: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(300)
    .describe('Maximum number of blocks to fetch (default 300).'),
});

export type GetPageContentOutput = {
  id: string;
  title: string;
  content: string;
  block_count: number;
};

export function createGetPageContentTool(
  client: Client,
): ToolDefinition<typeof GetPageContentInput, GetPageContentOutput> {
  return {
    name: 'notion_get_page_content',
    description:
      'Read the full text content of a Notion page (paragraphs, headings, lists, code, etc.). Use this after notion_search or notion_get_page to read what is actually written on the page.',
    inputSchema: GetPageContentInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        // Get title
        const page = await client.pages.retrieve({ page_id: input.page_id });
        const title = extractTitle(
          page as { properties?: Record<string, { type: string; [k: string]: unknown }> },
        );

        // Fetch blocks
        const blocks = await paginateBlockChildren(client, input.page_id, input.max_blocks);
        const content = blocksToText(blocks);

        return {
          id: input.page_id,
          title,
          content: content || '(no extractable text content)',
          block_count: blocks.length,
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_create_page ────────────────────────────────────────────────────────

const CreatePageInput = z.object({
  parent_page_id: z
    .string()
    .optional()
    .describe(
      'ID of the parent PAGE. Use when creating a sub-page inside another page. Mutually exclusive with parent_database_id.',
    ),
  parent_database_id: z
    .string()
    .optional()
    .describe(
      'ID of the parent DATABASE. Use when creating a new row inside a database. Mutually exclusive with parent_page_id.',
    ),
  title: z.string().describe('Title of the new page.'),
  content: z
    .string()
    .optional()
    .describe('Optional paragraph text to add as the first block. Auto-chunked if >2000 chars.'),
});

export type CreatePageOutput = {
  id: string;
  url: string;
  title: string;
};

export function createCreatePageTool(
  client: Client,
): ToolDefinition<typeof CreatePageInput, CreatePageOutput> {
  return {
    name: 'notion_create_page',
    description:
      'Create a new Notion page. Provide EITHER parent_page_id (to nest under a page) OR parent_database_id (to create a row in a database) — not both.',
    inputSchema: CreatePageInput,
    riskLevel: 'write',
    async execute(input) {
      if (input.parent_page_id && input.parent_database_id) {
        throw mapNotionError(
          new Error('Provide either parent_page_id OR parent_database_id, not both.'),
        );
      }
      if (!input.parent_page_id && !input.parent_database_id) {
        throw mapNotionError(new Error('Must provide parent_page_id or parent_database_id.'));
      }

      try {
        let titlePropName = 'title';
        let parent: Parameters<typeof client.pages.create>[0]['parent'];

        if (input.parent_database_id) {
          // Discover title property name from schema
          parent = { database_id: input.parent_database_id };
          try {
            const db = await client.databases.retrieve({ database_id: input.parent_database_id });
            for (const [name, prop] of Object.entries(db.properties)) {
              if ((prop as { type: string }).type === 'title') {
                titlePropName = name;
                break;
              }
            }
          } catch {
            // Use default 'title'
          }
        } else {
          parent = { type: 'page_id', page_id: input.parent_page_id! };
        }

        const properties: Record<string, unknown> = {
          [titlePropName]: { title: chunkRichText(input.title) },
        };

        const children: Array<unknown> = [];
        if (input.content) {
          children.push({
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: chunkRichText(input.content) },
          });
        }

        const page = await client.pages.create({
          parent,
          properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
          ...(children.length > 0 && {
            children: children as Parameters<typeof client.pages.create>[0]['children'],
          }),
        });

        return {
          id: page.id,
          url: 'url' in page ? String(page.url) : '',
          title: input.title,
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_update_page ────────────────────────────────────────────────────────

const UpdatePageInput = z.object({
  page_id: z.string().describe('Page ID to update.'),
  properties: z
    .record(z.unknown())
    .describe(
      'Properties to update as key-value pairs. Example: {"Status": "Done", "Priority": "High", "Score": 95}',
    ),
});

export type UpdatePageOutput = {
  id: string;
  updated_properties: number;
};

export function createUpdatePageTool(
  client: Client,
): ToolDefinition<typeof UpdatePageInput, UpdatePageOutput> {
  return {
    name: 'notion_update_page',
    description:
      'Update properties of a Notion page (title, status, select, text, number, etc.). Use notion_query_database first to discover the correct property names and types.',
    inputSchema: UpdatePageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Fetch page to discover DB schema for type coercion
        let dbSchema: Record<string, { type: string }> | null = null;
        try {
          const page = await client.pages.retrieve({ page_id: input.page_id });
          const parent =
            'parent' in page ? (page.parent as { type: string; database_id?: string }) : null;
          if (parent?.type === 'database_id' && parent.database_id) {
            const db = await client.databases.retrieve({ database_id: parent.database_id });
            dbSchema = {};
            for (const [name, prop] of Object.entries(db.properties)) {
              dbSchema[name] = { type: (prop as { type: string }).type };
            }
          }
        } catch {
          // Schema not available — will infer from value
        }

        const properties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input.properties)) {
          if (value == null) continue;
          properties[key] = buildNotionProperty(key, value, dbSchema);
        }

        await client.pages.update({
          page_id: input.page_id,
          properties: properties as Parameters<typeof client.pages.update>[0]['properties'],
        });

        return { id: input.page_id, updated_properties: Object.keys(properties).length };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_archive_page ───────────────────────────────────────────────────────

const ArchivePageInput = z.object({
  page_id: z.string().describe('Page ID to archive.'),
});

export type ArchivePageOutput = { id: string; archived: true };

export function createArchivePageTool(
  client: Client,
): ToolDefinition<typeof ArchivePageInput, ArchivePageOutput> {
  return {
    name: 'notion_archive_page',
    description: 'Archive (soft-delete) a Notion page. The page can be restored from trash.',
    inputSchema: ArchivePageInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await client.pages.update({ page_id: input.page_id, archived: true });
        return { id: input.page_id, archived: true };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
