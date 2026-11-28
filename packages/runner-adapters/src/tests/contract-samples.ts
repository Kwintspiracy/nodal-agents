// contract-samples.ts — inputs of the operations whose schema the suite cannot fill alone.
//
// Every other operation's input is derived from its schema (`sampleFromSchema`:
// its required fields, each with a plain value). These are the operations
// whose schema refines further (one of two fields, a real address), each
// with the least input that reaches the provider.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIL = { to: 'someone@example.com', subject: 'Contract', body: 'Contract body.' };

const GMAIL = {
  gmail_modify_labels: { message_id: 'm-1', add_labels: ['STARRED'] },
  gmail_create_draft: MAIL,
  gmail_update_draft: { draft_id: 'd-1', ...MAIL },
  gmail_forward_message: { message_id: 'm-1', to: 'someone@example.com' },
  gmail_send_email: MAIL,
};

const NOTION = {
  notion_create_page: { parent_page_id: 'page-1', title: 'Contract' },
  notion_update_database: { database_id: 'db-1', title: 'Contract' },
};

const AIRTABLE = {};

export const CONTRACT_SAMPLE_INPUTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  gmail: GMAIL,
  'google-sheets': {
    sheets_find_rows: { spreadsheet_id: 'sheet-1', column: 'Name', equals: 'Ada' },
    sheets_format_range: {
      spreadsheet_id: 'sheet-1',
      sheet_id: 0,
      start_row_index: 0,
      end_row_index: 1,
      start_column_index: 0,
      end_column_index: 1,
      bold: true,
    },
  },
  'google-docs': {
    docs_format_text: { document_id: 'doc-1', start_index: 1, end_index: 2, bold: true },
  },
  notion: NOTION,
  'notion-oauth': NOTION,
  airtable: AIRTABLE,
  'airtable-oauth': AIRTABLE,
  'outlook-mail': {
    outlook_update_message: { message_id: 'm-1', is_read: true },
    outlook_create_draft: MAIL,
    outlook_update_draft: { draft_id: 'd-1', subject: 'Contract' },
    outlook_forward_message: { message_id: 'm-1', to: 'someone@example.com' },
    outlook_send_email: MAIL,
  },
  cloudflare: {
    cloudflare_deploy: { name: 'contract-site', directory: 'site' },
  },
};

let site: string | null = null;

/** A workspace holding a built site, for the deploy operation (read before any request). */
function siteWorkspace(): Array<{ label: string; path: string }> {
  if (!site) {
    site = mkdtempSync(join(tmpdir(), 'nodal-contract-site-'));
    mkdirSync(join(site, 'site'));
    writeFileSync(join(site, 'site', 'index.html'), '<!doctype html><title>contract</title>');
  }
  return [{ label: 'site', path: join(site, 'site') }];
}

/** What a call of these operations needs in its context beyond the job's ids. */
export function contractSampleContext(adapter: string, operation: string): Record<string, unknown> {
  if (adapter === 'cloudflare' && operation === 'cloudflare_deploy') {
    return { workspaces: siteWorkspace() };
  }
  return {};
}
