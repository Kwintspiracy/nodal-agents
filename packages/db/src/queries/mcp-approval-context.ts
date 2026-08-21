// mcp-approval-context.ts — resolve which MCP server is behind a namespaced
// tool name, so an approval card can name it.
//
// Lives here because it is a DB read and only packages/db may touch drizzle
// (dep-cruiser `only-db-imports-pg`), and because BOTH surfaces need it: the
// runner renders channel cards, the dashboard renders the approvals page. One
// implementation keeps the two from drifting — the wording of an approval is
// exactly the kind of thing that silently diverges between surfaces.

import { and, eq } from 'drizzle-orm';
import { mcpServers } from '../schema/mcp';
import type { AnyDrizzleDb } from '../client';

/** `my-server-name` → `my_server_name`. Mirrors slugToPrefix in adapter-mcp. */
function slugToPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/** Split `<prefix>__<tool>`; null for a built-in (builtins carry no `__`). */
export function splitMcpToolName(toolName: string): { prefix: string; tool: string } | null {
  const i = toolName.indexOf('__');
  return i > 0 ? { prefix: toolName.slice(0, i), tool: toolName.slice(i + 2) } : null;
}

export interface McpApprovalContext {
  slug: string;
  name: string;
  /** URL for http transport, command for stdio. */
  endpoint: string;
  /** Description THIS server supplies for the tool. Third-party text. */
  toolDescription?: string;
  /**
   * The server's own `readOnlyHint`. A HINT, never a security decision — it
   * softens the card's wording; the approval was required regardless.
   */
  readOnlyHint?: boolean;
  /** True when several slugs collapse onto the same prefix (see below). */
  ambiguous: boolean;
  /** The rule pattern that would cover every tool of this server. */
  rulePattern: string;
}

interface DiscoveredTool {
  name?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown } | null;
}

/**
 * The MCP server behind `toolName`, or null when it is a built-in or unknown.
 *
 * Matching is on the DERIVED prefix, not the slug: `slugToPrefix` is lossy —
 * every non-alphanumeric run collapses to `_` — so `a-b` and `a.b` produce the
 * same prefix. When that happens the result is flagged `ambiguous` so the card
 * can say so, rather than silently naming one of them.
 */
export async function getMcpApprovalContext(
  db: AnyDrizzleDb,
  entityId: string,
  toolName: string,
): Promise<McpApprovalContext | null> {
  const parsed = splitMcpToolName(toolName);
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
  const row = matches[0];
  if (!row) return null;

  const endpoint =
    row.transport === 'http'
      ? (row.url ?? '(url manquante)')
      : (row.command ?? '(commande manquante)');

  let toolDescription: string | undefined;
  let readOnlyHint: boolean | undefined;
  const tools = Array.isArray(row.availableTools) ? (row.availableTools as DiscoveredTool[]) : [];
  for (const t of tools) {
    if (t && typeof t === 'object' && t.name === parsed.tool) {
      if (typeof t.description === 'string') toolDescription = t.description;
      if (typeof t.annotations?.readOnlyHint === 'boolean')
        readOnlyHint = t.annotations.readOnlyHint;
      break;
    }
  }

  return {
    slug: row.slug,
    name: row.name,
    endpoint,
    ...(toolDescription ? { toolDescription } : {}),
    ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
    ambiguous: matches.length > 1,
    rulePattern: `${parsed.prefix}__*`,
  };
}
