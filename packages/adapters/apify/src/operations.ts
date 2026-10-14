// @nodal-agents/adapter-apify — operation descriptors.
// Each slug MUST match the tool name produced by createApifyTools() exactly.
// Risk classification:
//   read        — apify_get_run, apify_list_datasets, apify_get_dataset_items
//   destructive — apify_run_actor: runs an ARBITRARY marketplace program (any
//                 actorId, any input) whose outside effects and spend are
//                 unknown, unbounded and cannot be taken back (#744), so it is
//                 `destructive` + requiresApproval, like Gmail's sends.
//                 Metered, bounded calls with no outside effect (search,
//                 scrape, image generation) do not ask: the criterion is not
//                 "spends credits".

import type { OperationDescriptor } from '@nodal-agents/shared';

export const APIFY_OPERATIONS: OperationDescriptor[] = [
  // ─── Destructive (1) ───────────────────────────────────────────────────────────────
  {
    slug: 'apify_run_actor',
    name: 'Run actor',
    risk: 'destructive',
    requiresApproval: true,
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
