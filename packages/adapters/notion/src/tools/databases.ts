// @nodalai/adapter-notion — database tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors.js';
import {
  extractPropertyValue,
  chunkRichText,
  buildNotionProperty,
} from '../helpers/property-coerce.js';
import { paginateAll } from '../helpers/pagination.js';

// ── notion_query_database ─────────────────────────────────────────────────────

const QueryDatabaseInput = z.object({
  database_id: z.string().describe('Notion database ID (UUID).'),
  filter: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional Notion filter object. Example: {"property": "Status", "select": {"equals": "Applied"}}',
    ),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe('Rows per request (1–100, default 50).'),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(500)
    .describe('Total rows to collect across pagination (default 500, max 1000).'),
});

type QueryRow = { id: string; url: string } & Record<string, string>;

export type QueryDatabaseOutput = {
  total: number;
  has_more: boolean;
  rows: QueryRow[];
};

export function createQueryDatabaseTool(
  client: Client,
): ToolDefinition<typeof QueryDatabaseInput, QueryDatabaseOutput> {
  return {
    name: 'notion_query_database',
    description:
      'Query a Notion database with optional filters. Without a filter, returns all entries. Returns rows with their properties.',
    inputSchema: QueryDatabaseInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        let hitMax = false;
        const rows = await paginateAll(
          async (cursor, pageSize) => {
            const body: Parameters<typeof client.databases.query>[0] = {
              database_id: input.database_id,
              page_size: pageSize,
            };
            if (input.filter)
              body.filter = input.filter as Parameters<typeof client.databases.query>[0]['filter'];
            if (cursor) body.start_cursor = cursor;
            const res = await client.databases.query(body);
            return {
              results: res.results,
              has_more: res.has_more,
              next_cursor: res.next_cursor,
            };
          },
          input.page_size,
          input.max_rows,
        );

        if (rows.length >= input.max_rows) hitMax = true;

        const output: QueryRow[] = rows.map((row) => {
          const entry: QueryRow = {
            id: row.id,
            url: 'url' in row ? String(row.url) : '',
          };
          if ('properties' in row) {
            for (const [name, prop] of Object.entries(
              row.properties as Record<string, { type: string; [k: string]: unknown }>,
            )) {
              const val = extractPropertyValue(prop);
              if (val) entry[name] = val;
            }
          }
          return entry;
        });

        return { total: output.length, has_more: hitMax, rows: output };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_get_database ───────────────────────────────────────────────────────

const GetDatabaseInput = z.object({
  database_id: z.string().describe('Notion database ID (UUID).'),
});

export type GetDatabaseOutput = {
  id: string;
  title: string;
  url: string;
  columns: Array<{
    name: string;
    type: string;
    options?: string[];
  }>;
};

export function createGetDatabaseTool(
  client: Client,
): ToolDefinition<typeof GetDatabaseInput, GetDatabaseOutput> {
  return {
    name: 'notion_get_database',
    description:
      'Get the schema of a Notion database (column names, types, and select/multi_select options). Call this to discover database structure before querying or creating rows.',
    inputSchema: GetDatabaseInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const db = await client.databases.retrieve({ database_id: input.database_id });
        // DatabaseObjectResponse has title: RichTextItemResponse[]; PartialDatabaseObjectResponse does not
        const titleArr = 'title' in db ? (db.title as Array<{ plain_text: string }>) : [];
        const title = titleArr.map((p) => p.plain_text).join('') || '(untitled)';
        const url = 'url' in db ? String(db.url) : '';

        const columns = Object.entries(db.properties).map(([name, prop]) => {
          const typedProp = prop as { type: string; [k: string]: unknown };
          const col: { name: string; type: string; options?: string[] } = {
            name,
            type: typedProp.type,
          };

          if (typedProp.type === 'select') {
            const opts =
              (typedProp['select'] as { options?: Array<{ name: string }> })?.options ?? [];
            col.options = opts.slice(0, 20).map((o) => o.name);
          } else if (typedProp.type === 'multi_select') {
            const opts =
              (typedProp['multi_select'] as { options?: Array<{ name: string }> })?.options ?? [];
            col.options = opts.slice(0, 20).map((o) => o.name);
          } else if (typedProp.type === 'status') {
            const opts =
              (typedProp['status'] as { options?: Array<{ name: string }> })?.options ?? [];
            col.options = opts.slice(0, 20).map((o) => o.name);
          }

          return col;
        });

        return { id: db.id, title, url, columns };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_create_database_entry ──────────────────────────────────────────────

const CreateDatabaseEntryInput = z.object({
  database_id: z.string().describe('Notion database ID to add a row to.'),
  properties: z
    .record(z.unknown())
    .describe(
      'Row properties as key-value pairs. Example: {"Name": "Acme Corp", "Status": "Applied", "Score": 95}',
    ),
});

export type CreateDatabaseEntryOutput = {
  id: string;
  url: string;
};

export function createCreateDatabaseEntryTool(
  client: Client,
): ToolDefinition<typeof CreateDatabaseEntryInput, CreateDatabaseEntryOutput> {
  return {
    name: 'notion_create_database_entry',
    description:
      'Create a new row (entry) in a Notion database. Use notion_get_database first to discover property names and types.',
    inputSchema: CreateDatabaseEntryInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Fetch schema for proper type coercion
        let dbSchema: Record<string, { type: string }> | null = null;
        let titlePropName = 'Name';
        try {
          const db = await client.databases.retrieve({ database_id: input.database_id });
          dbSchema = {};
          for (const [name, prop] of Object.entries(db.properties)) {
            const t = (prop as { type: string }).type;
            dbSchema[name] = { type: t };
            if (t === 'title') titlePropName = name;
          }
        } catch {
          // Fall back to type inference
        }

        const properties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input.properties)) {
          if (value == null) continue;
          properties[key] = buildNotionProperty(key, value, dbSchema);
        }

        // Ensure title property exists
        if (!properties[titlePropName]) {
          const firstStr = Object.entries(input.properties).find(
            ([, v]) => typeof v === 'string' && v,
          );
          if (firstStr) {
            properties[titlePropName] = { title: chunkRichText(firstStr[1] as string) };
          }
        }

        const page = await client.pages.create({
          parent: { database_id: input.database_id },
          properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
        });

        return {
          id: page.id,
          url: 'url' in page ? String(page.url) : '',
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_update_database_entry ──────────────────────────────────────────────

const UpdateDatabaseEntryInput = z.object({
  page_id: z.string().describe('Page ID of the database row to update.'),
  database_id: z
    .string()
    .optional()
    .describe(
      'Optional: database ID to fetch schema for type coercion. If omitted, types are inferred from values.',
    ),
  properties: z
    .record(z.unknown())
    .describe('Properties to update as key-value pairs. Example: {"Status": "Done", "Score": 100}'),
});

export type UpdateDatabaseEntryOutput = {
  id: string;
  updated_properties: number;
};

export function createUpdateDatabaseEntryTool(
  client: Client,
): ToolDefinition<typeof UpdateDatabaseEntryInput, UpdateDatabaseEntryOutput> {
  return {
    name: 'notion_update_database_entry',
    description:
      'Update properties of a Notion database row. Use notion_get_database to discover property names and types.',
    inputSchema: UpdateDatabaseEntryInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        let dbSchema: Record<string, { type: string }> | null = null;

        // Try to get schema from provided database_id or from page parent
        const dbId = input.database_id;
        if (dbId) {
          try {
            const db = await client.databases.retrieve({ database_id: dbId });
            dbSchema = {};
            for (const [name, prop] of Object.entries(db.properties)) {
              dbSchema[name] = { type: (prop as { type: string }).type };
            }
          } catch {
            // Ignore
          }
        } else {
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
            // Ignore
          }
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

// ── notion_create_database ────────────────────────────────────────────────────

const ColumnTypeSchema = z.enum([
  'title',
  'rich_text',
  'number',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'date',
  'select',
  'multi_select',
  'status',
]);

const CreateDatabaseInput = z.object({
  parent_page_id: z.string().describe('Page ID that will contain the new database.'),
  title: z.string().describe('Database title.'),
  columns: z
    .record(ColumnTypeSchema)
    .describe(
      'Column definitions as {name: type}. One must be "title". Example: {"Name": "title", "Status": "select", "URL": "url", "Score": "number"}',
    ),
});

export type CreateDatabaseOutput = {
  id: string;
  url: string;
  title: string;
};

function buildColumnSchema(type: z.infer<typeof ColumnTypeSchema>): Record<string, unknown> {
  switch (type) {
    case 'title':
      return { title: {} };
    case 'select':
      return { select: { options: [] } };
    case 'multi_select':
      return { multi_select: { options: [] } };
    case 'status':
      return { status: {} };
    default:
      return { [type]: {} };
  }
}

export function createCreateDatabaseTool(
  client: Client,
): ToolDefinition<typeof CreateDatabaseInput, CreateDatabaseOutput> {
  return {
    name: 'notion_create_database',
    description:
      'Create a new database inside a Notion page. Define columns with their types (title, rich_text, select, multi_select, number, checkbox, url, date, email).',
    inputSchema: CreateDatabaseInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const properties: Record<string, unknown> = {};
        for (const [name, type] of Object.entries(input.columns)) {
          properties[name] = buildColumnSchema(type);
        }

        const db = await client.databases.create({
          parent: { type: 'page_id', page_id: input.parent_page_id },
          title: [{ type: 'text', text: { content: input.title } }],
          properties: properties as Parameters<typeof client.databases.create>[0]['properties'],
        });

        return {
          id: db.id,
          url: 'url' in db ? String(db.url) : '',
          title: input.title,
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_update_database ────────────────────────────────────────────────────

const UpdateDatabaseInput = z.object({
  database_id: z.string().describe('Database ID to update.'),
  title: z.string().optional().describe('Optional new title for the database.'),
  new_columns: z
    .record(ColumnTypeSchema)
    .optional()
    .describe(
      'New columns to add as {name: type}. Same types as notion_create_database. Cannot modify existing column types (Notion API limitation).',
    ),
});

export type UpdateDatabaseOutput = {
  id: string;
  changes: string[];
};

export function createUpdateDatabaseTool(
  client: Client,
): ToolDefinition<typeof UpdateDatabaseInput, UpdateDatabaseOutput> {
  return {
    name: 'notion_update_database',
    description:
      'Update a database schema — add new columns or rename the database. Cannot modify existing column types (Notion API limitation).',
    inputSchema: UpdateDatabaseInput,
    riskLevel: 'write',
    async execute(input) {
      if (!input.title && !input.new_columns) {
        throw mapNotionError(new Error('Provide title and/or new_columns to update.'));
      }

      try {
        const payload: Record<string, unknown> = {};
        const changes: string[] = [];

        if (input.title) {
          payload['title'] = [{ type: 'text', text: { content: input.title } }];
          changes.push(`title → "${input.title}"`);
        }

        if (input.new_columns && Object.keys(input.new_columns).length > 0) {
          const properties: Record<string, unknown> = {};
          for (const [name, type] of Object.entries(input.new_columns)) {
            properties[name] = buildColumnSchema(type);
          }
          payload['properties'] = properties;
          changes.push(`${Object.keys(input.new_columns).length} column(s) added`);
        }

        await client.databases.update({
          database_id: input.database_id,
          ...payload,
        } as Parameters<typeof client.databases.update>[0]);

        return { id: input.database_id, changes };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
