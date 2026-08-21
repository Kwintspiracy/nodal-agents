// @nodal-agents/adapter-cloudflare — cloudflare_list_workers / cloudflare_delete_worker.
// Both go through the official SDK; the account id is resolved from the token
// (client.ts), never asked to the model.

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { CloudflareAccountContext } from '../client.ts';
import { wrapCloudflareError } from '../client.ts';
import { WORKER_NAME_RE } from './deploy.ts';

const ListInput = z.object({});

export type ListWorkersOutput = {
  accountId: string;
  workers: Array<{ name: string; url: string; modifiedOn: string | null }>;
};

export function makeCloudflareListWorkersTool(
  account: CloudflareAccountContext,
): ToolDefinition<typeof ListInput, ListWorkersOutput> {
  return {
    name: 'cloudflare_list_workers',
    description:
      'List the Workers deployed on the connected Cloudflare account, with their ' +
      'workers.dev preview URLs.',
    inputSchema: ListInput,
    riskLevel: 'read',
    async execute() {
      const { accountId, subdomain } = await account.resolve();
      try {
        const workers: ListWorkersOutput['workers'] = [];
        for await (const script of account.client.workers.scripts.list({
          account_id: accountId,
        })) {
          if (!script.id) continue;
          workers.push({
            name: script.id,
            url: `https://${script.id}.${subdomain}.workers.dev`,
            modifiedOn: typeof script.modified_on === 'string' ? script.modified_on : null,
          });
        }
        return { accountId, workers };
      } catch (err) {
        throw wrapCloudflareError(err);
      }
    },
  };
}

const DeleteInput = z.object({
  name: z
    .string()
    .regex(WORKER_NAME_RE, 'Invalid Worker name.')
    .describe('The Worker to delete — its workers.dev URL goes offline immediately.'),
});

export type DeleteWorkerOutput = { deleted: string };

export function makeCloudflareDeleteWorkerTool(
  account: CloudflareAccountContext,
): ToolDefinition<typeof DeleteInput, DeleteWorkerOutput> {
  return {
    name: 'cloudflare_delete_worker',
    description:
      'Permanently delete a Worker from the connected Cloudflare account. Its ' +
      'workers.dev URL goes offline immediately — irreversible.',
    inputSchema: DeleteInput,
    riskLevel: 'destructive',
    defaultApproval: 'require_approval',
    async execute(input) {
      const { accountId } = await account.resolve();
      try {
        await account.client.workers.scripts.delete(input.name, { account_id: accountId });
        return { deleted: input.name };
      } catch (err) {
        throw wrapCloudflareError(err);
      }
    },
  };
}
