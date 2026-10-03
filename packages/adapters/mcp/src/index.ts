// @nodal-agents/adapter-mcp — connect to a remote MCP server (Streamable
// HTTP) and expose its tools as NodalAI ToolDefinitions.
//
// Unlike the hand-coded API adapters (firecrawl, notion…), MCP tools are
// discovered dynamically: connect → tools/list → wrap each tool.

import type { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import {
  connectMcp,
  type McpConnectOptions,
  type McpServerDiscovery,
  type McpToolDescriptor,
} from './client.ts';
import { mcpToolToToolDefinition, mcpToolToLazyToolDefinition } from './tools.ts';

/**
 * McpConnectOptions is a discriminated union (transport: 'http' | 'stdio'),
 * so we use intersection rather than interface extension — TypeScript
 * doesn't allow extending a union with `interface`. The intersection
 * distributes `slug` across both branches, preserving the discriminant.
 */
export type CreateMcpToolsOptions = McpConnectOptions & {
  /** Server slug — namespaces tool names (e.g. `cogni_cortex__get_home`). */
  slug: string;
};

export interface McpToolset {
  tools: ToolDefinition<z.ZodTypeAny, unknown>[];
  /**
   * Full tool descriptors backing `tools` — for the eager toolset these are
   * fresh off the connection; for the lazy toolset these are the cached
   * descriptors it was built from (the fresh ones, if any, only exist after
   * `onConnected` fires). Callers use this to write back `mcp_servers.
   * available_tools` (Lot A3 — lazy MCP connect cache).
   */
  descriptors: McpToolDescriptor[];
  /** Close the underlying MCP transport. ALWAYS call this when done. */
  close: () => Promise<void>;
}

/** An eagerly connected toolset also knows what the server published at initialize. */
export interface ConnectedMcpToolset extends McpToolset {
  /** The server's `instructions`, fresh off this connection (null: it published none). */
  instructions: string | null;
}

/**
 * Connect to an MCP server, discover its tools, and wrap each as a NodalAI
 * ToolDefinition. The caller MUST call `close()` when finished — typically in
 * a `finally` once the job's LLM loop ends.
 *
 * Throws on connection failure or auth rejection (callers decide whether to
 * fail loud or skip the server).
 */
export async function createMcpTools(opts: CreateMcpToolsOptions): Promise<ConnectedMcpToolset> {
  const conn = await connectMcp(opts);
  const tools = conn.tools.map((t) => mcpToolToToolDefinition(conn.client, t, opts.slug));
  return { tools, descriptors: conn.tools, instructions: conn.instructions, close: conn.close };
}

export interface CreateLazyMcpToolsOptions {
  /**
   * Called once, right after a successful lazy connect, with what the live
   * server says NOW — its tools (not the cached ones the toolset was built
   * from) and its instructions. Used to refresh `mcp_servers.available_tools`
   * and `mcp_servers.instructions` so the next job reads them. Errors thrown
   * by this hook are swallowed — a cache-refresh failure must never break the
   * tool call that triggered the connection.
   */
  onConnected?: (live: McpServerDiscovery) => void | Promise<void>;
}

/**
 * Build an MCP toolset from a CACHED descriptor list — no connection is made.
 * Each tool's `execute()` connects lazily, at most once per toolset, via a
 * memoized promise shared across concurrent calls: the first real tool call
 * pays the connect cost (30-120s for a cold stdio spawn), every call after —
 * including calls that raced the first one — reuses the same live client. A
 * failed connect is NOT memoized: it rejects (surfacing as a normal tool
 * error, invariant #4 — fail loud) and the next call gets to retry.
 *
 * Lot A3 (harness plan): avoids paying the connect cost on every job/resume
 * when no MCP tool ends up being called — measured at ~90s dead time per
 * resume in prod for a stdio server.
 */
export function createLazyMcpTools(
  opts: CreateMcpToolsOptions,
  cachedDescriptors: McpToolDescriptor[],
  lazyOpts: CreateLazyMcpToolsOptions = {},
): McpToolset {
  let connectPromise: ReturnType<typeof connectMcp> | null = null;

  function ensureConnected() {
    if (!connectPromise) {
      connectPromise = connectMcp(opts)
        .then((conn) => {
          if (lazyOpts.onConnected) {
            const live = { tools: conn.tools, instructions: conn.instructions };
            Promise.resolve(lazyOpts.onConnected(live)).catch((err: unknown) => {
              console.error(
                `[adapter-mcp] onConnected cache-refresh hook failed for '${opts.slug}':`,
                err instanceof Error ? err.message : err,
              );
            });
          }
          return conn;
        })
        .catch((err: unknown) => {
          // Don't memoize a failed connect — the next tool call gets to retry.
          connectPromise = null;
          throw err;
        });
    }
    return connectPromise.then((conn) => conn.client);
  }

  const tools = cachedDescriptors.map((d) =>
    mcpToolToLazyToolDefinition(ensureConnected, d, opts.slug),
  );

  return {
    tools,
    descriptors: cachedDescriptors,
    close: async () => {
      // Never connecting (no MCP tool was called this job) is a no-op, not an
      // error. But a connect still IN FLIGHT when the job loop's finally runs
      // (e.g. the triggering tool call timed out while a cold stdio spawn was
      // underway) must be awaited and closed too — otherwise the subprocess
      // outlives the job as an orphan (Windows especially never reaps it).
      const pending = connectPromise;
      if (!pending) return;
      const conn = await pending.catch(() => null); // failed connect → nothing to close
      if (conn) await conn.close();
    },
  };
}

export { connectMcp, buildMcpRequest } from './client.ts';
export type {
  McpConnectOptions,
  McpConnection,
  McpServerDiscovery,
  McpToolDescriptor,
  McpAuthScheme,
  McpRequestTarget,
} from './client.ts';
export { mcpToolToToolDefinition, mcpToolToLazyToolDefinition, slugToPrefix } from './tools.ts';
export { jsonSchemaToZod } from './json-schema-to-zod.ts';
export { mcpResultForModel, recordMcpResult } from './result.ts';
export type { McpToolOutput, McpRecordedBlock } from './result.ts';
