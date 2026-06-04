// @nodal-agents/adapter-apify — operation descriptors.
// Each slug MUST match the tool name produced by createApifyTools() exactly.
// Risk classification:
//   read  — apify_get_run, apify_list_datasets, apify_get_dataset_items
//   write — apify_run_actor (spawns a remote run and consumes user credits)

import type { OperationDescriptor } from '@nodal-agents/shared';

export const APIFY_OPERATIONS: OperationDescriptor[] = [
  // ─── Write (1) ───────────────────────────────────────────────────────────────
  {
    slug: 'apify_run_actor',
    name: 'Run actor',
    risk: 'write',
    requiresApproval: false,
    description:
      'Start an Apify actor run and wait for it to finish. Consumes Apify platform credits.',
  },

  // ─── Read (4) ────────────────────────────────────────────────────────────────
  {
    slug: 'apify_web_browse',
    name: 'Web browse',
    risk: 'read',
    requiresApproval: false,
    description:
      'Scrape a web page or run a web search and get the content back in one synchronous call (no polling). Consumes a small amount of Apify credits.',
  },
  {
    slug: 'apify_get_run',
    name: 'Get run',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve metadata for an Apify actor run by its run ID.',
  },
  {
    slug: 'apify_list_datasets',
    name: 'List datasets',
    risk: 'read',
    requiresApproval: false,
    description: "List datasets in the user's Apify account with optional pagination.",
  },
  {
    slug: 'apify_get_dataset_items',
    name: 'Get dataset items',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve items from an Apify dataset. Supports limit and offset pagination.',
  },
];
