// autonomy-template.ts — the value a NEW autonomy row is written with (#917).
//
// Owner's decision, 2026-11-01: "as soon as an agent exists and a tool is
// available, the value of its autonomy must exist in the database, always,
// for every agent". The screen shows that row, the gate applies that row
// (execute.ts), and nothing is computed between them.
//
// So the posture that used to be computed at RUN TIME for a tool without a
// rule (its `defaultApproval`, relaxed by the workspace autonomy level) is
// computed here instead, ONCE, when the row is written: an agent created, a
// tool that becomes available to it. The row then says it, and the owner can
// read and change it. The workspace autonomy level is a template, and nothing
// else.
//
// Pure: no DB, no I/O. The writer lives in @nodal-agents/orchestration
// (`autonomy-rows.ts`), which reads the agent's tools with the code the
// whitelist uses (invariant #9).

import {
  explainTemplateRules,
  REPLACE_SHARED_FILE_SETTING,
  type ApprovalRuleForChain,
  type AutonomyLevel,
} from '@nodal-agents/shared';
import type { ApprovalRuleAction } from '@nodal-agents/shared';
import { isCodeExecutionTool } from './execute';

/** What the template reads of a tool: its declared posture and reach. */
export interface TemplateTool {
  name: string;
  defaultApproval?: 'require_approval';
  riskLevel: 'read' | 'write' | 'destructive';
}

/**
 * The value the workspace autonomy level gives a tool's row.
 *
 * The same meaning the levels had at run time until #917, now written once:
 *
 *   - a tool that does not ask by itself (no `defaultApproval`) runs without
 *     asking, at every level;
 *   - `propose_confirm` keeps every asking tool on Ask first;
 *   - `fully_autonomous` lets them all run, EXCEPT the tools that run code on
 *     this machine (`CODE_EXECUTION_TOOL_NAMES`): a blanket "never ask me"
 *     never was consent to hand an agent a shell (P0 review of 2026-08-25);
 *   - `destructive_gate` lets them run unless the tool is declared
 *     destructive. A shell command is judged by the command, not by the tool:
 *     `run_command` and `declare_verification` declare `destructive` as a
 *     blanket safe-by-default level, and the agent's checklist (#464) judges
 *     every command they run, at every setting. `create_mcp` likewise: a stdio
 *     server always asks before it starts (a floor of the gate), an http
 *     server spawns nothing.
 */
export function levelTemplate(tool: TemplateTool, level: AutonomyLevel): ApprovalRuleAction {
  if (tool.defaultApproval !== 'require_approval') return 'auto_approve';
  if (level === 'fully_autonomous') {
    return isCodeExecutionTool(tool.name) ? 'require_approval' : 'auto_approve';
  }
  if (level === 'destructive_gate') {
    if (
      tool.name === 'run_command' ||
      tool.name === 'declare_verification' ||
      tool.name === 'create_mcp'
    ) {
      return 'auto_approve';
    }
    return tool.riskLevel === 'destructive' ? 'require_approval' : 'auto_approve';
  }
  return 'require_approval';
}

/**
 * The value the level gives the shared-file setting
 * (`REPLACE_SHARED_FILE_SETTING`): what applied before #917, when the check
 * ran inside the tools — off under `fully_autonomous`, Ask first otherwise.
 */
export function sharedFileLevelTemplate(level: AutonomyLevel): ApprovalRuleAction {
  return level === 'fully_autonomous' ? 'auto_approve' : 'require_approval';
}

/**
 * The value a NEW row of `agentId` × `tool` is written with.
 *
 * A template rule the owner set wins (`explainTemplateRules`: Everyone + this
 * tool, the server's setting, a `*` rule), so a server the owner trusted
 * gives its new tools that trust. Then the level.
 *
 * One exception keeps its meaning from before #917: a `*` → Autonomous rule
 * does not reach a tool that runs code (security review of 2026-08-25). Only
 * a row naming that tool, set by the owner, lets it run without asking.
 * Hardening is never neutralised: a `*` → Ask first or Block still applies.
 */
export function templateAutonomy(
  tool: TemplateTool,
  ctx: {
    level: AutonomyLevel;
    rules: readonly ApprovalRuleForChain[];
    agentId: string;
    entityId: string;
  },
): ApprovalRuleAction {
  const template = explainTemplateRules(ctx.rules, tool.name, ctx.agentId, ctx.entityId).find(
    (r) => !(r.toolName === '*' && r.action === 'auto_approve' && isCodeExecutionTool(tool.name)),
  );
  if (template) return template.action;
  if (tool.name === REPLACE_SHARED_FILE_SETTING) return sharedFileLevelTemplate(ctx.level);
  return levelTemplate(tool, ctx.level);
}
