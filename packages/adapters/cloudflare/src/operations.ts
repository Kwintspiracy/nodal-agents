// @nodal-agents/adapter-cloudflare — operation descriptors.
// Each slug MUST match the tool name produced by createCloudflareTools() exactly.
// Risk classification:
//   cloudflare_deploy        — write, requiresApproval: publishing to the public
//                              internet is an outward-facing action.
//   cloudflare_list_workers  — read.
//   cloudflare_delete_worker — destructive (takes a live site/app offline).

import type { OperationDescriptor } from '@nodal-agents/shared';

export const CLOUDFLARE_OPERATIONS: OperationDescriptor[] = [
  {
    slug: 'cloudflare_deploy',
    name: 'Deploy to Workers',
    risk: 'write',
    requiresApproval: true,
    description:
      'Publish a built static site/app directory from the agent workspace to Cloudflare ' +
      'Workers — live at https://<name>.<account>.workers.dev within seconds.',
  },
  {
    slug: 'cloudflare_list_workers',
    name: 'List Workers',
    risk: 'read',
    requiresApproval: false,
    description: 'List the Workers deployed on the connected Cloudflare account.',
  },
  {
    slug: 'cloudflare_delete_worker',
    name: 'Delete Worker',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a Worker (its workers.dev URL goes offline immediately).',
  },
];
