// Wrap discovered MCP tools as NodalAI ToolDefinitions.

import type { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { OperationRiskLevel } from '@nodal-agents/shared';
import type { McpToolDescriptor } from './client.ts';
import { jsonSchemaToZod } from './json-schema-to-zod.ts';

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
 * Wrap one discovered MCP tool as a NodalAI ToolDefinition.
 *
 * - `name` is namespaced with the server slug (`cogni_cortex__get_home`) so
 *   MCP tool names never collide with builtins or other servers' tools.
 * - `execute` dispatches to the live MCP client via `callTool`; an MCP-side
 *   error (`isError: true`) is rethrown so `executeTool` records it.
 */
export function mcpToolToToolDefinition(
  client: Client,
  mcpTool: McpToolDescriptor,
  slug: string,
): ToolDefinition<z.ZodTypeAny, unknown> {
  const originalName = mcpTool.name;
  return {
    name: `${slugToPrefix(slug)}__${originalName}`,
    description: mcpTool.description ?? `MCP tool ${originalName}`,
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
    riskLevel: riskFromAnnotations(mcpTool.annotations),
    async execute(input) {
      const result = await client.callTool({
        name: originalName,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
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
      if (result.structuredContent != null) return result.structuredContent;
      const content = result.content ?? [];
      if (
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((c) => (c as { type?: unknown }).type === 'text')
      ) {
        return extractText(content);
      }
      return content;
    },
  };
}
