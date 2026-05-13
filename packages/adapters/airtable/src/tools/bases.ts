// @nodal-agents/adapter-airtable — bases and tables tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { AirtableClient } from '../client.ts';
import { wrapAirtableError } from '../errors.ts';

// ── airtable_list_bases ───────────────────────────────────────────────────────

const ListBasesInput = z.object({});

export type AirtableBase = {
  id: string;
  name: string;
  permissionLevel: string;
};

export type ListBasesOutput = {
  bases: AirtableBase[];
};

export function makeAirtableListBasesTool(
  client: AirtableClient,
): ToolDefinition<typeof ListBasesInput, ListBasesOutput> {
  return {
    name: 'airtable_list_bases',
    description:
      'List all Airtable bases the integration has access to. Returns base IDs and names needed for other airtable_ tools.',
    inputSchema: ListBasesInput,
    riskLevel: 'read',
    async execute(_input) {
      try {
        const data = (await client.get('/meta/bases')) as {
          bases: Array<{ id: string; name: string; permissionLevel: string }>;
        };
        return {
          bases: (data.bases ?? []).map((b) => ({
            id: b.id,
            name: b.name,
            permissionLevel: b.permissionLevel,
          })),
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}

// ── airtable_list_tables ─────────────────────────────────────────────────────

const ListTablesInput = z.object({
  baseId: z
    .string()
    .describe('The Airtable base ID (e.g. appXXXXXXXX). Use airtable_list_bases to find it.'),
});

export type AirtableTable = {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: Array<{ id: string; name: string; type: string }>;
};

export type ListTablesOutput = {
  tables: AirtableTable[];
};

export function makeAirtableListTablesTool(
  client: AirtableClient,
): ToolDefinition<typeof ListTablesInput, ListTablesOutput> {
  return {
    name: 'airtable_list_tables',
    description:
      'List all tables in an Airtable base including their field schemas. Use this to discover table IDs and field names before reading or writing records.',
    inputSchema: ListTablesInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const data = (await client.get(`/meta/bases/${input.baseId}/tables`)) as {
          tables: Array<{
            id: string;
            name: string;
            primaryFieldId: string;
            fields: Array<{ id: string; name: string; type: string }>;
          }>;
        };
        return {
          tables: (data.tables ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            primaryFieldId: t.primaryFieldId,
            fields: (t.fields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
          })),
        };
      } catch (err) {
        throw wrapAirtableError(err);
      }
    },
  };
}
