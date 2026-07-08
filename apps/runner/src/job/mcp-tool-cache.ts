// mcp-tool-cache.ts — decides whether mcp_servers.available_tools is a usable
// "v2" cache (Lot A3 — lazy MCP connect) for a given server.
//
// v1 cache (written by create-mcp.ts, historical) only ever stored
// {name, description} per tool. v2 stores the FULL McpToolDescriptor
// (inputSchema + annotations included) — enough for createLazyMcpTools to
// build real ToolDefinitions synchronously, with no connection. A server
// still on a v1 cache (or with no cache at all) falls back to the eager path
// once, which then writes back a v2 cache for every job after.

import type { McpToolDescriptor } from '@nodal-agents/adapter-mcp';

/**
 * True when `availableTools` (the raw JSONB column value, typed `unknown`
 * before this check) is a non-empty array of full v2 descriptors — every
 * entry carries an `inputSchema` key. Pure and synchronous — no DB, no I/O.
 */
export function isUsableMcpToolCache(
  availableTools: unknown,
): availableTools is McpToolDescriptor[] {
  if (!Array.isArray(availableTools) || availableTools.length === 0) return false;
  return availableTools.every(
    (t) =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as { name?: unknown }).name === 'string' &&
      (t as { inputSchema?: unknown }).inputSchema !== undefined,
  );
}
