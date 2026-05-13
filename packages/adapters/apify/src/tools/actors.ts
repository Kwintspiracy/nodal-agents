// @nodal-agents/adapter-apify — actor run tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { ApifyClient } from '../client.ts';
import { wrapApifyError } from '../errors.ts';

// ── apify_run_actor ───────────────────────────────────────────────────────────

const RunActorInput = z.object({
  actorId: z
    .string()
    .describe(
      'The actor ID or name in the format "owner/actor-name" (e.g. "apify/web-scraper") or just the actor ID.',
    ),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Input object to pass to the actor. Structure depends on the actor. Omit to use actor defaults.',
    ),
});

export type RunActorOutput = {
  runId: string;
  datasetId: string;
  status: string;
};

/**
 * Calls client.actor(actorId).call(input) which blocks until the run finishes.
 * The SDK handles polling internally — this tool will not return until the actor
 * run reaches a terminal state (SUCCEEDED, FAILED, ABORTED, etc.).
 */
export function makeApifyRunActorTool(
  client: ApifyClient,
): ToolDefinition<typeof RunActorInput, RunActorOutput> {
  return {
    name: 'apify_run_actor',
    description:
      'Start an Apify actor run and wait for it to finish (blocking). Returns the run ID, output dataset ID, and final status. This tool consumes Apify platform credits — use apify_get_dataset_items to retrieve results after the run succeeds.',
    inputSchema: RunActorInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const run = await client.actor(input.actorId).call(input.input);
        return {
          runId: run.id,
          datasetId: run.defaultDatasetId,
          status: run.status,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}

// ── apify_get_run ─────────────────────────────────────────────────────────────

const GetRunInput = z.object({
  runId: z.string().describe('The Apify run ID to retrieve metadata for.'),
});

export type GetRunOutput = {
  id: string;
  actId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
};

export function makeApifyGetRunTool(
  client: ApifyClient,
): ToolDefinition<typeof GetRunInput, GetRunOutput> {
  return {
    name: 'apify_get_run',
    description:
      'Retrieve metadata for an Apify actor run by its run ID. Returns status, actor ID, dataset ID, and timestamps.',
    inputSchema: GetRunInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const run = await client.run(input.runId).get();
        if (!run) {
          const { ApifyApiError } = await import('../errors.ts');
          throw new ApifyApiError('apify_not_found', `Run ${input.runId} not found`, 404);
        }
        return {
          id: run.id,
          actId: run.actId,
          status: run.status,
          startedAt: run.startedAt ? run.startedAt.toISOString() : null,
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
          defaultDatasetId: run.defaultDatasetId,
          defaultKeyValueStoreId: run.defaultKeyValueStoreId,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}
