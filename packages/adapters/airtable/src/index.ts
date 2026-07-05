// @nodal-agents/adapter-airtable — public API
// Single factory: createAirtableTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createAirtableClient } from './client.ts';
import { makeAirtableListBasesTool, makeAirtableListTablesTool } from './tools/bases.ts';
import {
  makeAirtableListRecordsTool,
  makeAirtableGetRecordTool,
  makeAirtableCreateRecordsTool,
  makeAirtableUpdateRecordTool,
  makeAirtableReplaceRecordTool,
  makeAirtableDeleteRecordTool,
} from './tools/records.ts';

/**
 * Auth options for the Airtable adapter.
 *
 * Both OAuth access tokens and Personal Access Tokens are sent as
 * `Authorization: Bearer <token>` — the Airtable API makes no wire distinction.
 */
export type AirtableAdapterOptions =
  | {
      /**
       * Static access token (OAuth or PAT), captured once for the tools'
       * lifetime. Fine for short-lived callers (tests, the UI operations
       * grid) or a PAT (which doesn't expire). Jobs using an OAuth
       * connector that may outlive the ~60min token TTL should pass
       * getAccessToken instead (audit#2 M-12).
       */
      accessToken: string;
    }
  | {
      /**
       * Resolver called before every Airtable API request — re-reads (and,
       * via the runner's advisory-lock refresh path, refreshes) the
       * credential from the DB instead of capturing one token for the
       * tools' lifetime.
       */
      getAccessToken: () => Promise<string>;
    };

/**
 * Create all 8 Airtable tools using the provided access token or PAT.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 8
 * Read (4):        airtable_list_bases, airtable_list_tables,
 *                  airtable_list_records, airtable_get_record
 * Write (3):       airtable_create_records, airtable_update_record,
 *                  airtable_replace_record
 * Destructive (1): airtable_delete_record
 */
export function createAirtableTools(
  opts: AirtableAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  if ('accessToken' in opts && !opts.accessToken) {
    throw new Error('AirtableAdapterOptions: accessToken must be a non-empty string.');
  }

  const getAccessToken =
    'getAccessToken' in opts ? opts.getAccessToken : async () => opts.accessToken;
  const client = createAirtableClient(getAccessToken);

  return [
    // Read tools (4)
    makeAirtableListBasesTool(client),
    makeAirtableListTablesTool(client),
    makeAirtableListRecordsTool(client),
    makeAirtableGetRecordTool(client),

    // Write tools (3)
    makeAirtableCreateRecordsTool(client),
    makeAirtableUpdateRecordTool(client),
    makeAirtableReplaceRecordTool(client),

    // Destructive tools (1)
    makeAirtableDeleteRecordTool(client),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { AirtableApiError } from './errors.ts';
export type { AirtableErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { AIRTABLE_OPERATIONS } from './operations.ts';
