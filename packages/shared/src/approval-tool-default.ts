// approval-tool-default.ts — what a tool does when NO approval rule matches.
//
// The approval card has to answer "why am I being asked?" even when the answer
// is "nobody wrote a rule, this tool asks by itself". That line needs the
// tool's own `defaultApproval`, and the dashboard cannot read the tool registry
// (apps/web does not depend on @nodal-agents/tools, and must not: the registry
// drags the DB driver).
//
// So the list lives here, and `packages/tools/src/tests/approval-tool-default.test.ts`
// walks the REAL registry and fails if the two disagree — in either direction.
// A tool that becomes safe-by-default and is not added here turns the card's
// explanation into a lie, which is the exact failure issue #346 was about.

import { namespaceOfToolName } from './approval-rules-chain';
import type { ApprovalRuleAction } from './enums';

/**
 * Built-in and connector tools that declare `defaultApproval: 'require_approval'`
 * — "Ask first" with no rule at all. Kept sorted, and kept in step with the
 * registry by the test named above.
 *
 * Every tool from a third-party MCP server is also safe-by-default
 * (`packages/adapters/mcp/src/tools.ts`), but those are matched by their `__`
 * namespace rather than listed: their names come from servers the owner adds.
 */
export const SAFE_BY_DEFAULT_TOOL_NAMES: readonly string[] = [
  'attach_agent',
  'attach_connector',
  'attach_mcp',
  'attach_skill',
  'cloudflare_delete_worker',
  'cloudflare_deploy',
  'code_task',
  'create_agent',
  'create_connector',
  'create_mcp',
  'create_schedule',
  'create_skill',
  'declare_verification',
  'detach_agent',
  'detach_connector',
  'detach_mcp',
  'detach_skill',
  'register_project',
  'run_command',
  'run_schedule',
  'run_skill_script',
  'skill_file_write',
  'toggle_schedule',
  'update_agent',
  'update_schedule',
  'update_skill',
  'xlsx_delete_columns',
  'xlsx_delete_rows',
];

const SAFE_BY_DEFAULT = new Set(SAFE_BY_DEFAULT_TOOL_NAMES);

/**
 * The posture a tool takes when no rule names it: 'require_approval' for a
 * safe-by-default tool or any MCP tool, 'auto_approve' otherwise.
 *
 * 'auto_approve' here means "runs without asking", which is what the card shows
 * as Autonomous. It is a statement about the ABSENCE of a rule, never a rule.
 */
export function resolveToolDefaultApproval(toolName: string): ApprovalRuleAction {
  if (namespaceOfToolName(toolName) !== null) return 'require_approval';
  return SAFE_BY_DEFAULT.has(toolName) ? 'require_approval' : 'auto_approve';
}
