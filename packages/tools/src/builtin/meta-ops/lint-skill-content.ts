// meta-ops/lint-skill-content.ts — agnostic, allowlist-based linter for
// ROOT-authored skills.
//
// Why this exists: an LLM authoring a skill tends to fall back on its training
// prior (Claude-Desktop / Cursor MCP conventions: `mcp__Server__tool`,
// `Claude_in_Chrome`, a `{"mcpServers": …}` config block) instead of NodalAI's
// real tool names. Those skills then reference tools that don't exist here and
// silently misbehave. This linter catches that BEFORE the skill is persisted.
//
// Key insight that makes the check both broad AND false-positive-safe: in
// NodalAI, ONLY MCP tools carry a `__` (the `<slug>__<tool>` namespace).
// Built-ins and connector/adapter tools are bare snake_case. So we validate
// every `__`-namespaced token in the content against the workspace's REAL MCP
// tool set — anything else is a foreign/invented reference, agnostically (this
// catches `mcp__Apify__…`, `mcp__afc06b1f-…`, `mcp__Claude_in_Chrome__navigate`,
// and any wrong `slug__tool`, not just two hardcoded literals). Bare snake_case
// (prose, builtins, connector tools) is never touched.

import { eq, and } from '@nodal-agents/db';
import { mcpServers } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

export type SkillLintResult = { ok: true } | { ok: false; error: string };

/** Mirror of slugToPrefix in @nodal-agents/adapter-mcp — replicated here
 *  because packages/tools cannot import adapter-mcp (would create an import
 *  cycle: adapter-mcp already depends on @nodal-agents/tools). */
function slugToPrefix(slug: string): string {
  return slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/**
 * The real `<slug>__<tool>` MCP tool names available in a workspace — the set
 * a skill may legitimately reference. Shared by the linter (allowlist) AND by
 * the runner (injected into the create_skill / update_skill descriptions so the
 * ROOT agent sees the real names BEFORE authoring). Entity-scoped: lists every
 * active MCP server's tools, regardless of which agent is assigned them.
 */
export async function listWorkspaceMcpToolNames(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<string[]> {
  const rows = await db
    .select({ slug: mcpServers.slug, availableTools: mcpServers.availableTools })
    .from(mcpServers)
    .where(and(eq(mcpServers.entityId, entityId), eq(mcpServers.active, true)));

  const names: string[] = [];
  for (const r of rows) {
    const prefix = slugToPrefix(r.slug);
    const tools = Array.isArray(r.availableTools) ? r.availableTools : [];
    for (const t of tools) {
      const name =
        typeof t === 'string'
          ? t
          : t && typeof t === 'object' && 'name' in t
            ? String((t as { name: unknown }).name)
            : '';
      if (name) names.push(`${prefix}__${name}`);
    }
  }
  return names;
}

const CONVENTION_HINT =
  'NodalAI MCP tools are named "<server-slug>__<tool>" (e.g. "airtable__list_records_for_table", ' +
  '"apify__apify--rag-web-browser"). There is NO "mcp__…" prefix and no Claude-Desktop / Cursor / ' +
  'Claude-in-Chrome tooling here. Built-in and connector tools are bare snake_case and need no ' +
  'namespace. If you adapted an example from another platform, translate its tool names to NodalAI, ' +
  'or omit tool names and let the agent discover them at runtime.';

/**
 * Validate that a skill's content only references tools that exist in this
 * NodalAI workspace. Pure-DB read (no writes). Never throws on a normal path.
 */
export async function lintSkillContent(
  db: AnyDrizzleDb,
  entityId: string,
  content: string,
): Promise<SkillLintResult> {
  // 1. Structural reject: a Claude-Desktop / Cursor MCP config block.
  if (/"mcpServers"\s*:/.test(content)) {
    return {
      ok: false,
      error:
        'This skill embeds a `"mcpServers": …` config block, which belongs to another MCP client ' +
        `(Claude Desktop / Cursor), not NodalAI. Remove it. ${CONVENTION_HINT}`,
    };
  }

  // 2. Build the workspace's real MCP tool allowlist (only MCP tools carry `__`).
  const allow = new Set(await listWorkspaceMcpToolNames(db, entityId));

  // 3. Flag any `__`-namespaced token in the content not present in the allowlist.
  const tokens = content.match(/\b[\w-]+__[\w-]+\b/g) ?? [];
  const offenders = [...new Set(tokens)].filter((tok) => !allow.has(tok));

  if (offenders.length > 0) {
    const available =
      allow.size > 0
        ? [...allow].slice(0, 40).join(', ')
        : '(no MCP servers connected in this workspace)';
    return {
      ok: false,
      error:
        `This skill references tool names that don't exist in this workspace: ${offenders.join(', ')}. ` +
        `${CONVENTION_HINT} Available MCP tools here: ${available}.`,
    };
  }

  return { ok: true };
}
