// explain-request.ts — resolve everything an approval card needs to be readable.
//
// `explainApproval` (packages/shared) is pure: it knows how to WORD a gated call
// but not where a tool comes from. The lookup lives in packages/db
// (`getMcpApprovalContext`) because only that package may touch drizzle, and
// because the dashboard needs the exact same answer — the wording of an approval
// is precisely the kind of thing that drifts between surfaces when duplicated.
//
// Why the lookup matters: `mcp_fetch__fetch_markdown` on its own tells the owner
// nothing. "« fetch markdown » via Fetch (npx), reaching raw.githubusercontent.com"
// is a decision they can actually make.

import { getMcpApprovalContext } from '@nodal-agents/db';
import {
  explainApproval,
  redactSecretsForAudit,
  type ApprovalExplanation,
  type McpServerContext,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';

/**
 * Full explanation for one approval request.
 *
 * Arguments are redacted BEFORE they reach the explanation: `create_connector` /
 * `create_mcp` inputs carry API keys and stdio env values, and an approval card
 * gets displayed, forwarded and screenshotted.
 *
 * A failing lookup degrades to "MCP server not identified" rather than throwing:
 * an approval card that cannot render is worse than one missing its provenance,
 * because the job stays suspended with nothing shown.
 */
export async function explainApprovalRequest(
  db: RunnerDeps['db'],
  entityId: string,
  toolName: string,
  toolInput: unknown,
): Promise<ApprovalExplanation> {
  const ctx = await getMcpApprovalContext(db, entityId, toolName).catch(() => null);
  const mcp: McpServerContext | null = ctx
    ? {
        slug: ctx.slug,
        // Several slugs collapsing onto one prefix is possible — say so on the
        // card instead of silently showing the first one's name.
        name: ctx.ambiguous
          ? `${ctx.name} (attention : plusieurs serveurs partagent ce préfixe)`
          : ctx.name,
        endpoint: ctx.endpoint,
        ...(ctx.toolDescription ? { toolDescription: ctx.toolDescription } : {}),
        ...(ctx.readOnlyHint !== undefined ? { readOnlyHint: ctx.readOnlyHint } : {}),
      }
    : null;

  return explainApproval({
    toolName,
    toolInput: redactSecretsForAudit(toolInput ?? {}),
    mcp,
  });
}
