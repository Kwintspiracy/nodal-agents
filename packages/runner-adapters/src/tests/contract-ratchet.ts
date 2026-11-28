// contract-ratchet.ts — the operations that do not conform to the connector contract yet.
//
// The conformance suite (connector-contract.test.ts) compares what it
// measures with this list, both ways: an operation that starts conforming
// turns it red until its entry (or the rule in it) is removed, and an
// operation that breaks a rule not listed here turns it red. The list can only
// shrink: an adapter that is not in RATCHET_FROZEN_ADAPTERS (the registry as
// it was when the list was written) cannot appear in it, so a new adapter
// conforms from its first day.
//
// What each adapter needs is written above its entries.

import type { ContractRatchet } from '@nodal-agents/test-kit/connector-contract-suite';

/**
 * The operations that read a provider collection page by page, whether or
 * not they return the contract's list shape yet. One not declared
 * `returns: 'list'` breaks the list rules (and is listed below).
 */
export const LIST_OPERATIONS: readonly string[] = [
  'airtable_list_bases',
  'airtable_list_records',
  'apify_list_datasets',
  'apify_get_dataset_items',
  'firecrawl_crawl_status',
  'gmail_list_messages',
  'gmail_list_threads',
  'gmail_list_drafts',
  'gmail_list_history',
  'gcal_list_calendars',
  'gcal_list_events',
  'drive_list_files',
  'drive_list_permissions',
  'notion_search',
  'notion_query_database',
  'notion_list_comments',
  'notion_list_users',
  'outlook_list_messages',
  'outlook_list_drafts',
  'outlook_list_folders',
];

/** The registry when the ratchet was written (2026-11-28). No other adapter may be listed. */
export const RATCHET_FROZEN_ADAPTERS: readonly string[] = [
  'google-drive',
  'gmail',
  'google-calendar',
  'google-sheets',
  'notion-oauth',
  'google-docs',
  'notion',
  'outlook-mail',
  'firecrawl',
  'cloudflare',
  'tavily',
  'poyo',
  'airtable-oauth',
  'airtable',
  'apify',
];

export const CONTRACT_RATCHET: ContractRatchet = {
  // Same adapter as notion.
  'notion-oauth': {
    notion_search: ['list', 'cut'],
    notion_list_comments: ['list', 'cut'],
    notion_list_users: ['list', 'cut'],
  },
  // list: notion_search, notion_list_comments, notion_list_users, cursor = start_cursor.
  notion: {
    notion_search: ['list', 'cut'],
    notion_list_comments: ['list', 'cut'],
    notion_list_users: ['list', 'cut'],
  },
  // list: outlook_list_drafts, outlook_list_folders, cursor = @odata.nextLink (B43-05).
  'outlook-mail': {
    outlook_list_drafts: ['list', 'cut'],
    outlook_list_folders: ['list', 'cut'],
  },
  // transport: @mendable/firecrawl-js sends through axios and takes no fetch. Then list: firecrawl_crawl_status (its `next`).
  firecrawl: {
    firecrawl_scrape: ['transport', 'signal', 'rate_limited', 'cause'],
    firecrawl_crawl_start: ['transport', 'signal', 'rate_limited', 'cause'],
    firecrawl_crawl_status: ['transport', 'signal', 'rate_limited', 'cause', 'list', 'cut'],
    firecrawl_map: ['transport', 'signal', 'rate_limited', 'cause'],
    firecrawl_search: ['transport', 'signal', 'rate_limited', 'cause'],
  },
  // transport: @tavily/core sends through axios and takes no fetch.
  tavily: {
    tavily_search: ['transport', 'signal', 'rate_limited', 'cause'],
    tavily_extract: ['transport', 'signal', 'rate_limited', 'cause'],
    tavily_crawl: ['transport', 'signal', 'rate_limited', 'cause'],
  },
  // list: drive_list_permissions, cursor = pageToken.
  'google-drive': {
    drive_list_permissions: ['list', 'cut'],
  },
  // list: gmail_list_messages/threads/drafts/history return one page in the list shape, cursor = pageToken (B41-01, B41-02).
  gmail: {
    gmail_list_messages: ['list', 'cut'],
    gmail_list_threads: ['list', 'cut'],
    gmail_list_drafts: ['list', 'cut'],
    gmail_list_history: ['list', 'cut'],
  },
  // list: gcal_list_calendars/events, cursor = pageToken.
  'google-calendar': {
    gcal_list_calendars: ['list', 'cut'],
    gcal_list_events: ['list', 'cut'],
  },
  // Same adapter as airtable.
  'airtable-oauth': {
    airtable_list_bases: ['list', 'cut'],
  },
  // list: airtable_list_bases, cursor = offset.
  airtable: {
    airtable_list_bases: ['list', 'cut'],
  },
  // transport: apify-client sends through its own axios instance and takes no fetch; its requestInterceptors could set axios' fetch adapter with the contract's transport. Then list: apify_list_datasets, apify_get_dataset_items (offset).
  apify: {
    apify_run_actor: ['transport', 'signal', 'rate_limited', 'cause'],
    apify_web_browse: ['transport', 'signal', 'rate_limited', 'cause'],
    apify_get_run: ['transport', 'signal', 'rate_limited', 'cause'],
    apify_list_datasets: ['transport', 'signal', 'rate_limited', 'cause', 'list', 'cut'],
    apify_get_dataset_items: ['transport', 'signal', 'rate_limited', 'cause', 'list', 'cut'],
  },
};
