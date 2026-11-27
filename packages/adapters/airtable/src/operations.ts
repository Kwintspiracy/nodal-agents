// @nodal-agents/adapter-airtable — operation descriptors.
// Each slug MUST match the tool name produced by createAirtableTools() exactly.
// Risk classification:
//   read        — airtable_list_*, airtable_get_*
//   write       — airtable_create_*, airtable_update_*, airtable_replace_*
//   destructive — airtable_delete_*

import type { OperationDescriptor, ScopeRequirement } from '@nodal-agents/shared';

// OAuth rights, from the Airtable Web API reference (the scope each endpoint
// requires). A Personal Access Token carries the same scopes, chosen where the
// token was created, so the declaration is the same for both connectors.
const SCHEMA_READ: ScopeRequirement = ['schema.bases:read'];
const RECORDS_READ: ScopeRequirement = ['data.records:read'];
const RECORDS_WRITE: ScopeRequirement = ['data.records:write'];

export const AIRTABLE_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (4) ────────────────────────────────────────────────────────────────
  {
    slug: 'airtable_list_bases',
    name: 'List bases',
    risk: 'read',
    requiresApproval: false,
    scopes: [SCHEMA_READ],
    description: 'List all Airtable bases the integration has access to.',
  },
  {
    slug: 'airtable_list_tables',
    name: 'List tables',
    risk: 'read',
    requiresApproval: false,
    scopes: [SCHEMA_READ],
    description: 'List all tables and field schemas in a base.',
  },
  {
    slug: 'airtable_list_records',
    name: 'List records',
    risk: 'read',
    requiresApproval: false,
    scopes: [RECORDS_READ],
    description: 'List records in a table with optional filtering, sorting, and pagination.',
  },
  {
    slug: 'airtable_get_record',
    name: 'Get record',
    risk: 'read',
    requiresApproval: false,
    scopes: [RECORDS_READ],
    description: 'Retrieve a single record by its ID.',
  },

  // ─── Write (3) ───────────────────────────────────────────────────────────────
  {
    slug: 'airtable_create_records',
    name: 'Create records',
    risk: 'write',
    requiresApproval: false,
    scopes: [RECORDS_WRITE],
    description: 'Create one or more records in a table (max 10 per call).',
  },
  {
    slug: 'airtable_update_record',
    name: 'Update record',
    risk: 'write',
    requiresApproval: false,
    scopes: [RECORDS_WRITE],
    description: 'Update specific fields on a record (PATCH — unlisted fields unchanged).',
  },
  {
    slug: 'airtable_replace_record',
    name: 'Replace record',
    risk: 'write',
    requiresApproval: false,
    scopes: [RECORDS_WRITE],
    description: 'Fully replace all fields on a record (PUT — unlisted fields cleared).',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'airtable_delete_record',
    name: 'Delete record',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [RECORDS_WRITE],
    description: 'Permanently delete a single record. This action is irreversible.',
  },
];
