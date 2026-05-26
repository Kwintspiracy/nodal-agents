// @nodal-agents/adapter-mcp — connect to a remote MCP server (Streamable
// HTTP) and expose its tools as NodalAI ToolDefinitions.
//
// Unlike the hand-coded API adapters (firecrawl, notion…), MCP tools are
// discovered dynamically: connect → tools/list → wrap each tool.

import type { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import { connectMcp, type McpConnectOptions } from './client.ts';
import { mcpToolToToolDefinition } from './tools.ts';

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
  /** Close the underlying MCP transport. ALWAYS call this when done. */
  close: () => Promise<void>;
}

/**
 * Connect to an MCP server, discover its tools, and wrap each as a NodalAI
 * ToolDefinition. The caller MUST call `close()` when finished — typically in
 * a `finally` once the job's LLM loop ends.
 *
 * Throws on connection failure or auth rejection (callers decide whether to
 * fail loud or skip the server).
 */
export async function createMcpTools(opts: CreateMcpToolsOptions): Promise<McpToolset> {
  const conn = await connectMcp(opts);
  const tools = conn.tools.map((t) => mcpToolToToolDefinition(conn.client, t, opts.slug));
  return { tools, close: conn.close };
}

export { connectMcp, buildMcpRequest } from './client.ts';
export type {
  McpConnectOptions,
  McpConnection,
  McpToolDescriptor,
  McpAuthScheme,
  McpRequestTarget,
} from './client.ts';
export { mcpToolToToolDefinition, slugToPrefix } from './tools.ts';
export { jsonSchemaToZod } from './json-schema-to-zod.ts';
