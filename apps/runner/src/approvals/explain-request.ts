// explain-request.ts — resolve everything an approval card needs to be readable.
//
// `explainApproval` (packages/shared) is pure: it knows how to WORD a gated call
// but not where a tool comes from. This module does the lookups — which MCP
// server exposes this tool, what it is called, where it points, what description
// it supplies — and hands the result over.
//
// Why the lookup matters: `mcp_fetch__fetch_markdown` on its own tells the owner
// nothing. "« fetch markdown » via Fetch (npx), which will reach
// raw.githubusercontent.com" is a decision they can actually make.

import { eq, and } from '@nodal-agents/db';
import { mcpServers } from '@nodal-agents/db';
import {
  explainApproval,
  parseMcpToolName,
  redactSecretsForAudit,
  type ApprovalExplanation,
  type McpServerContext,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';

/** `cogni-cortex-tatooine` → `cogni_cortex_tatooine`. Mirrors slugToPrefix in adapter-mcp. */
function slugToPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

interface DiscoveredTool {
  name?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown } | null;
}

/**
 * Find the MCP server behind a namespaced tool name.
 *
 * Matching is on the DERIVED prefix, not the slug: `slugToPrefix` is lossy
 * (dashes and dots all collapse to `_`), so two slugs can share a prefix. That
 * is a pre-existing property of the naming scheme, not something to paper over —
 * when several match, the card names the ambiguity rather than picking one.
 */
export async function resolveMcpContext(
  db: RunnerDeps['db'],
  entityId: string,
  toolName: string,
): Promise<McpServerContext | null> {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;

  const rows = await db
    .select({
      slug: mcpServers.slug,
      name: mcpServers.name,
      url: mcpServers.url,
      command: mcpServers.command,
      transport: mcpServers.transport,
      availableTools: mcpServers.availableTools,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.entityId, entityId), eq(mcpServers.active, true)));

  const matches = rows.filter((r) => slugToPrefix(r.slug) === parsed.prefix);
  if (matches.length === 0) return null;

  const row = matches[0]!;
  const endpoint =
    row.transport === 'http'
      ? (row.url ?? '(url manquante)')
      : (row.command ?? '(commande manquante)');

  // The server's own description for THIS tool, from the cached discovery list.
  let toolDescription: string | undefined;
  let readOnlyHint: boolean | undefined;
  const tools = Array.isArray(row.availableTools) ? (row.availableTools as DiscoveredTool[]) : [];
  for (const t of tools) {
    if (typeof t === 'object' && t !== null && t.name === parsed.tool) {
      if (typeof t.description === 'string') toolDescription = t.description;
      if (typeof t.annotations?.readOnlyHint === 'boolean') {
        readOnlyHint = t.annotations.readOnlyHint;
      }
      break;
    }
  }

  return {
    slug: row.slug,
    // Several slugs collapsing to one prefix is possible — say so on the card
    // instead of silently showing the first one's name.
    name:
      matches.length > 1
        ? `${row.name} (attention : ${matches.length} serveurs partagent ce préfixe)`
        : row.name,
    endpoint,
    ...(toolDescription ? { toolDescription } : {}),
    ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
  };
}

/**
 * Full explanation for one approval request.
 *
 * Arguments are redacted BEFORE they reach the explanation: `create_connector` /
 * `create_mcp` inputs carry API keys and stdio env values, and an approval card
 * is displayed, forwarded and screenshotted.
 */
export async function explainApprovalRequest(
  db: RunnerDeps['db'],
  entityId: string,
  toolName: string,
  toolInput: unknown,
): Promise<ApprovalExplanation> {
  const mcp = await resolveMcpContext(db, entityId, toolName).catch(() => null);
  return explainApproval({
    toolName,
    toolInput: redactSecretsForAudit(toolInput ?? {}),
    mcp,
  });
}
