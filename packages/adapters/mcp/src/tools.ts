// Wrap discovered MCP tools as NodalAI ToolDefinitions.

import type { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { OperationRiskLevel } from '@nodal-agents/shared';
import type { McpToolDescriptor } from './client.ts';
import { jsonSchemaToZod } from './json-schema-to-zod.ts';

// Per-request MCP tool-call timeout (ms). The SDK default (60s) is too short for
// heavy tools — a Blender/KeyShot render, a long browser scrape — which otherwise
// fail with "MCP error -32001: Request timed out" mid-operation. Default 3 min,
// overridable via MCP_CALL_TIMEOUT_MS; paired with resetTimeoutOnProgress so a
// server that streams progress can run longer still.
const MCP_CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS) || 180_000;

// audit#2026-07-07 F6: nothing capped the size of a returned MCP tool result.
// A third-party MCP server — buggy or actively malicious — can return several
// MB of text or structured data in one response, exploding the agent's token
// budget on a single tool call. 50k chars mirrors the CHAR_CAP pattern used by
// firecrawl/tavily (packages/adapters/firecrawl/src/tools/scrape.ts,
// packages/adapters/tavily/src/tools/search.ts). Overridable for servers that
// legitimately need more headroom.
const MCP_RESULT_CHAR_CAP = Number(process.env.MCP_RESULT_CHAR_CAP) || 50_000;

/**
 * Cap the size of a value returned by an MCP tool call.
 *
 * - Strings are truncated in place with a trailing marker (same pattern as
 *   capField/capText in firecrawl/tavily) — always valid text, still readable.
 * - Non-string values (structuredContent objects, raw content-block arrays)
 *   are NOT byte-sliced: slicing serialized JSON would hand the agent a
 *   syntactically broken payload, which is worse than the oversized-payload
 *   problem it's meant to fix. Instead they are wrapped with an explicit
 *   `truncated: true` flag and a JSON preview, so the caller can tell exactly
 *   what happened instead of silently receiving cut-off/corrupt data
 *   (invariant #4 — fail loud, no silent smart fallback).
 */
function capMcpResult(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MCP_RESULT_CHAR_CAP) return value;
    return (
      value.slice(0, MCP_RESULT_CHAR_CAP) +
      `\n\n[...truncated at ${MCP_RESULT_CHAR_CAP} chars — MCP tool result was larger]`
    );
  }
  const serialized = JSON.stringify(value) ?? '';
  if (serialized.length <= MCP_RESULT_CHAR_CAP) return value;
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, MCP_RESULT_CHAR_CAP),
  };
}

/** Sanitise a server slug into a tool-name-safe prefix (`cogni-cortex` → `cogni_cortex`). */
export function slugToPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/**
 * Map MCP tool annotations to a NodalAI risk level. Defaults to `write`
 * (conservative) so an un-annotated tool still passes through the approval
 * gate rather than being silently treated as harmless.
 */
function riskFromAnnotations(a: McpToolDescriptor['annotations']): OperationRiskLevel {
  if (a?.readOnlyHint === true) return 'read';
  if (a?.destructiveHint === true) return 'destructive';
  return 'write';
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        typeof c === 'object' &&
        c !== null &&
        (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string',
    )
    .map((c) => c.text)
    .join('\n');
}

/**
 * Dispatch one MCP tool call against a live client and shape the result.
 * Shared by the eager wrapper (client already connected at build time) and the
 * lazy wrapper (client obtained on first call via `ensureConnected()`) so the
 * isError/structuredContent/capping logic lives in exactly one place.
 */
async function callMcpTool(
  client: Client,
  originalName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool(
    { name: originalName, arguments: input },
    // Default result schema (CallToolResultSchema).
    undefined,
    // The MCP SDK's default per-request timeout is 60s — too short for heavy
    // tools (a Blender/KeyShot render, a long scrape). Raise it and reset the
    // clock whenever the server reports progress, so progress-streaming
    // servers can run even longer. Overridable via MCP_CALL_TIMEOUT_MS.
    { timeout: MCP_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
  );
  if (result.isError === true) {
    const detail = extractText(result.content);
    throw new Error(`MCP tool ${originalName} failed: ${detail || 'unknown error'}`);
  }
  // An MCP CallToolResult carries two payload channels (spec 2025-06-18):
  // the historical `content` blocks AND `structuredContent` for tools that
  // declare an outputSchema. The SDK defaults `content` to [] when the
  // server omits it, so a structured-output server (e.g. Airtable) that
  // returns its data in `structuredContent` would otherwise surface as an
  // empty result. Prefer structuredContent; else join text-only content
  // blocks (usually serialized JSON); else return the raw blocks so
  // images/resources are preserved.
  if (result.structuredContent != null) return capMcpResult(result.structuredContent);
  const content = result.content ?? [];
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((c) => (c as { type?: unknown }).type === 'text')
  ) {
    return capMcpResult(extractText(content));
  }
  return capMcpResult(content);
}

/**
 * Build the ToolDefinition shape for one discovered MCP tool. `getClient` is
 * called on every `execute()` — the eager wrapper resolves it immediately
 * (client already connected), the lazy wrapper (Lot A3) resolves it via
 * `ensureConnected()`, which only connects on the first real call.
 *
 * `name` is namespaced with the server slug (`cogni_cortex__get_home`) so MCP
 * tool names never collide with builtins or other servers' tools.
 */
function buildMcpToolDefinition(
  mcpTool: McpToolDescriptor,
  slug: string,
  getClient: () => Promise<Client>,
): ToolDefinition<z.ZodTypeAny, unknown> {
  const originalName = mcpTool.name;
  return {
    name: `${slugToPrefix(slug)}__${originalName}`,
    description: mcpTool.description ?? `MCP tool ${originalName}`,
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
    riskLevel: riskFromAnnotations(mcpTool.annotations),
    async execute(input) {
      const client = await getClient();
      return callMcpTool(client, originalName, (input ?? {}) as Record<string, unknown>);
    },
  };
}

/**
 * Wrap one discovered MCP tool as a NodalAI ToolDefinition, dispatching
 * `execute()` against an already-connected client.
 */
export function mcpToolToToolDefinition(
  client: Client,
  mcpTool: McpToolDescriptor,
  slug: string,
): ToolDefinition<z.ZodTypeAny, unknown> {
  return buildMcpToolDefinition(mcpTool, slug, () => Promise.resolve(client));
}

/**
 * Lazy variant (Lot A3): same wrapping, but `getClient` is invoked only when
 * `execute()` is actually called — letting the caller build the toolset from
 * a cached descriptor list with zero connections, and connect on first use.
 */
export function mcpToolToLazyToolDefinition(
  getClient: () => Promise<Client>,
  mcpTool: McpToolDescriptor,
  slug: string,
): ToolDefinition<z.ZodTypeAny, unknown> {
  return buildMcpToolDefinition(mcpTool, slug, getClient);
}
