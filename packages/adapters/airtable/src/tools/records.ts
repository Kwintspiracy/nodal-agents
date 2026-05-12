// @nodalai/adapter-airtable — record CRUD tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { AirtableClient } from '../client.ts';
import { wrapAirtableError } from '../errors.ts';

// ── airtable_list_records ─────────────────────────────────────────────────────

const SortItemSchema = z.object({
  field: z.string().describe('Field name to sort by.'),
  direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default asc).'),
});

const ListRecordsInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z
    .string()
    .describe(
      'The table ID (tblXXXXXXXX) or name within the base. Use airtable_list_tables to find it.',
    ),
  view: z.string().optional().describe('Name or ID of the view to use.'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(100)
    .describe('Number of records per page (1–100, default 100).'),
  offset: z.string().optional().describe('Pagination offset token from a previous response.'),
  fields: z
    .array(z.string())
    .optional()
    .describe('List of field names to return. Omit to return all fields.'),
  filterByFormula: z
    .string()
    .optional()
    .describe('Airtable formula to filter records. Example: "AND({Status}=\'Active\',{Score}>80)"'),
  sort: z
    .array(SortItemSchema)
    .optional()
    .describe('List of sort objects with field and optional direction.'),
});

export type AirtableRecord = {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
};

export type ListRecordsOutput = {
  records: AirtableRecord[];
  offset: string | undefined;
};

export function makeAirtableListRecordsTool(
  client: AirtableClient,
): ToolDefinition<typeof ListRecordsInput, ListRecordsOutput> {
  return {
    name: 'airtable_list_records',
    description:
      'List records in an Airtable table. Supports filtering by formula, sorting, field selection, and pagination via offset token.',
    inputSchema: ListRecordsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const params: Record<string, string | number | boolean | string[]> = {
          pageSize: input.pageSize ?? 100,
        };
        if (input.view) params['view'] = input.view;
        if (input.offset) params['offset'] = input.offset;
        if (input.filterByFormula) params['filterByFormula'] = input.filterByFormula;
        if (input.fields && input.fields.length > 0) {
          // Airtable expects repeated: fields[]=Name&fields[]=Status
          params['fields[]'] = input.fields;
        }
        if (input.sort && input.sort.length > 0) {
          // Airtable expects: sort[0][field]=Name&sort[0][direction]=asc
          for (let i = 0; i < input.sort.length; i++) {
            const s = input.sort[i];
            if (s) {
              params[`sort[${i}][field]`] = s.field;
              if (s.direction) params[`sort[${i}][direction]`] = s.direction;
            }
          }
        }

        const data = (await client.get(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}`,
          params,
        )) as {
          records: Array<{ id: string; fields: Record<string, unknown>; createdTime: string }>;
          offset?: string;
        };

        return {
          records: (data.records ?? []).map((r) => ({
            id: r.id,
            fields: r.fields ?? {},
            createdTime: r.createdTime,
          })),
          offset: data.offset,
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_get_record ───────────────────────────────────────────────────────

const GetRecordInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z.string().describe('The table ID or name within the base.'),
  recordId: z.string().describe('The record ID (recXXXXXXXX) to retrieve.'),
});

export type GetRecordOutput = AirtableRecord;

export function makeAirtableGetRecordTool(
  client: AirtableClient,
): ToolDefinition<typeof GetRecordInput, GetRecordOutput> {
  return {
    name: 'airtable_get_record',
    description:
      'Retrieve a single record from an Airtable table by its record ID. Returns all field values.',
    inputSchema: GetRecordInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const data = (await client.get(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}/${input.recordId}`,
        )) as { id: string; fields: Record<string, unknown>; createdTime: string };

        return {
          id: data.id,
          fields: data.fields ?? {},
          createdTime: data.createdTime,
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_create_records ───────────────────────────────────────────────────

const CreateRecordsInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z.string().describe('The table ID or name within the base.'),
  records: z
    .array(z.object({ fields: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(10)
    .describe(
      'Array of records to create, each with a fields object. Max 10 per call. Example: [{"fields": {"Name": "Alice", "Status": "Active"}}]',
    ),
  typecast: z
    .boolean()
    .optional()
    .describe(
      'If true, Airtable will attempt to convert string values to the appropriate field type. Default false.',
    ),
});

export type CreateRecordsOutput = {
  records: Array<{ id: string; fields: Record<string, unknown>; createdTime: string }>;
};

export function makeAirtableCreateRecordsTool(
  client: AirtableClient,
): ToolDefinition<typeof CreateRecordsInput, CreateRecordsOutput> {
  return {
    name: 'airtable_create_records',
    description:
      'Create one or more records in an Airtable table. Max 10 records per call. Field names must match the table schema exactly.',
    inputSchema: CreateRecordsInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const body: Record<string, unknown> = { records: input.records };
        if (input.typecast) body['typecast'] = true;

        const data = (await client.post(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}`,
          body,
        )) as {
          records: Array<{ id: string; fields: Record<string, unknown>; createdTime: string }>;
        };

        return {
          records: (data.records ?? []).map((r) => ({
            id: r.id,
            fields: r.fields ?? {},
            createdTime: r.createdTime,
          })),
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_update_record ────────────────────────────────────────────────────

const UpdateRecordInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z.string().describe('The table ID or name within the base.'),
  recordId: z.string().describe('The record ID (recXXXXXXXX) to update.'),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'Fields to update as key-value pairs. Only specified fields are changed (PATCH semantics). Example: {"Status": "Done", "Score": 95}',
    ),
  typecast: z
    .boolean()
    .optional()
    .describe('If true, attempt to convert string values to the appropriate field type.'),
});

export type UpdateRecordOutput = {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
};

export function makeAirtableUpdateRecordTool(
  client: AirtableClient,
): ToolDefinition<typeof UpdateRecordInput, UpdateRecordOutput> {
  return {
    name: 'airtable_update_record',
    description:
      'Update specific fields on a single Airtable record (PATCH — only listed fields are changed, others remain). Use airtable_replace_record to overwrite all fields.',
    inputSchema: UpdateRecordInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const body: Record<string, unknown> = { fields: input.fields };
        if (input.typecast) body['typecast'] = true;

        const data = (await client.patch(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}/${input.recordId}`,
          body,
        )) as { id: string; fields: Record<string, unknown>; createdTime: string };

        return {
          id: data.id,
          fields: data.fields ?? {},
          createdTime: data.createdTime,
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_replace_record ───────────────────────────────────────────────────

const ReplaceRecordInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z.string().describe('The table ID or name within the base.'),
  recordId: z.string().describe('The record ID (recXXXXXXXX) to replace.'),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'Complete field set to write. Fields NOT included will be cleared (PUT semantics). Use airtable_update_record for partial updates.',
    ),
  typecast: z
    .boolean()
    .optional()
    .describe('If true, attempt to convert string values to the appropriate field type.'),
});

export type ReplaceRecordOutput = UpdateRecordOutput;

export function makeAirtableReplaceRecordTool(
  client: AirtableClient,
): ToolDefinition<typeof ReplaceRecordInput, ReplaceRecordOutput> {
  return {
    name: 'airtable_replace_record',
    description:
      'Fully replace all fields on a single Airtable record (PUT — fields not listed are cleared to empty). Use airtable_update_record for partial field updates.',
    inputSchema: ReplaceRecordInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const body: Record<string, unknown> = { fields: input.fields };
        if (input.typecast) body['typecast'] = true;

        const data = (await client.put(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}/${input.recordId}`,
          body,
        )) as { id: string; fields: Record<string, unknown>; createdTime: string };

        return {
          id: data.id,
          fields: data.fields ?? {},
          createdTime: data.createdTime,
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_delete_record ────────────────────────────────────────────────────

const DeleteRecordInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
  tableIdOrName: z.string().describe('The table ID or name within the base.'),
  recordId: z
    .string()
    .describe(
      'The record ID (recXXXXXXXX) to delete. This action is permanent and cannot be undone.',
    ),
});

export type DeleteRecordOutput = {
  id: string;
  deleted: true;
};

export function makeAirtableDeleteRecordTool(
  client: AirtableClient,
): ToolDefinition<typeof DeleteRecordInput, DeleteRecordOutput> {
  return {
    name: 'airtable_delete_record',
    description:
      'Permanently delete a single record from an Airtable table. This is irreversible — confirm the record ID with airtable_get_record before deleting.',
    inputSchema: DeleteRecordInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        const data = (await client.delete(
          `/${input.baseId}/${encodeURIComponent(input.tableIdOrName)}/${input.recordId}`,
        )) as { id: string; deleted: boolean };

        return {
          id: data.id,
          deleted: true,
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}
