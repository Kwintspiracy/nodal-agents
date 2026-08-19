// @nodal-agents/adapter-cloudflare — public API
// Single factory: createCloudflareTools(opts) → ToolDefinition[]
//
// The experience (demande Quentin 20/08) : an agent that just coded a
// site/app in its workspace publishes it to Cloudflare Workers and answers
// with the live workers.dev preview URL — remote-coding with an instant
// online preview. Auth = ONE Cloudflare API Token (connectors UI, api_key
// flow); the account id and workers.dev subdomain are derived from it.

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { CloudflareAccountContext } from './client.ts';
import { makeCloudflareDeployTool } from './tools/deploy.ts';
import { makeCloudflareListWorkersTool, makeCloudflareDeleteWorkerTool } from './tools/manage.ts';

export type CloudflareAdapterOptions = {
  /** Cloudflare API Token — template « Edit Cloudflare Workers ». */
  accessToken: string;
};

/**
 * Create the 3 Cloudflare tools using the provided API token.
 *
 * Tool count: 3
 * Read (1):        cloudflare_list_workers
 * Write (1):       cloudflare_deploy          (require_approval by default)
 * Destructive (1): cloudflare_delete_worker   (require_approval by default)
 */
export function createCloudflareTools(
  opts: CloudflareAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('CloudflareAdapterOptions: accessToken must be a non-empty string.');
  }

  const account = new CloudflareAccountContext(opts.accessToken);

  return [
    makeCloudflareDeployTool(account),
    makeCloudflareListWorkersTool(account),
    makeCloudflareDeleteWorkerTool(account),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

export { CloudflareApiError } from './errors.ts';
export type { CloudflareErrorCode } from './errors.ts';
export { CLOUDFLARE_OPERATIONS } from './operations.ts';
export { WORKER_NAME_RE, buildWranglerDeployArgs, WRANGLER_SPEC } from './tools/deploy.ts';
