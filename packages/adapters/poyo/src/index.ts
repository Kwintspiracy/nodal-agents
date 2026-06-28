// @nodal-agents/adapter-poyo — public API
// Single factory: createPoyoTools(opts) → ToolDefinition[]
//
// Tools exposed (1 total):
//   poyo_generate_image — text-to-image generation via Poyo (submit + wait)
//
// No official SDK exists, so the client is a hand-rolled fetch wrapper.

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createPoyoClient } from './client.ts';
import { makePoyoGenerateImageTool } from './tools/generate.ts';

/**
 * Auth options for the Poyo adapter.
 * Pass your Poyo API key via `{ accessToken }`.
 */
export type PoyoAdapterOptions = {
  accessToken: string;
};

/**
 * Create the Poyo tools using the provided API key.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 1
 * Write (1): poyo_generate_image
 */
export function createPoyoTools(opts: PoyoAdapterOptions): ToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('PoyoAdapterOptions: accessToken must be a non-empty string.');
  }

  const client = createPoyoClient(opts.accessToken);

  return [makePoyoGenerateImageTool(client)] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { PoyoApiError } from './errors.ts';
export type { PoyoErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { POYO_OPERATIONS } from './operations.ts';
