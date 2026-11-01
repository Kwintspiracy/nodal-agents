// autonomy-rows.ts — every agent holds one autonomy row per tool it has (#917).
//
// Owner's decision, 2026-11-01: "as soon as an agent exists and a tool is
// available, the value of its autonomy must exist in the database, always,
// for every agent". The Autonomy tab shows that row; the gate
// (packages/tools/src/execute.ts) applies that row and refuses a call that has
// none. Nothing is computed between the two.
//
// This module is the ONE writer of the rows a tool's arrival calls for. It
// reads the agent's tools with the code the whitelist is built from
// (`resolveAgentTools`, invariant #9) and writes, for every tool without a
// row, the value the template gives (`templateAutonomy`, @nodal-agents/tools):
// a template rule the owner set (a server he trusted, a rule for every agent),
// else the workspace autonomy level. An existing row is never touched: it is
// the owner's, or was written before.
//
// When it runs — every moment a tool can become available, through one
// function rather than a hook per path:
//   - at the runner's boot, for every agent (a Nodal version that adds a
//     built-in, and the first boot after #917 for the agents that exist);
//   - at the start of every job, for the tools that job really holds (an MCP
//     server discovered by that connection, a skill or connector attached by
//     any path);
//   - when an agent is created, a tool source is attached (MCP server,
//     connector, skill, channel), or the Autonomy tab is opened.
//
// THE FIRST WRITE after the upgrade (`entities.autonomy_rows_written_at` NULL)
// keeps what the screen showed: nothing moves on screen, and the row becomes
// what is applied. Where the screen and the gate disagreed, the STRICTER of
// the two is written, so no permission widens (see `valueShownBefore917`).

import { and, eq, isNull, sql } from '@nodal-agents/db';
import { agents, approvalRules, entities, APPROVAL_ROW_KEY } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  explainApprovalRules,
  explainTemplateRules,
  isPatternToolName,
  namespaceOfToolName,
  parseRootGrants,
  REPLACE_SHARED_FILE_SETTING,
  type ApprovalRuleAction,
  type ApprovalRuleForChain,
  type AutonomyLevel,
} from '@nodal-agents/shared';
import {
  createToolRegistry,
  levelTemplate,
  registerBuiltins,
  sharedFileLevelTemplate,
  templateAutonomy,
  type TemplateTool,
} from '@nodal-agents/tools';
import {
  resolveAgentTools,
  WIDEST_PLACEMENT,
  type AgentToolSource,
} from './router/resolve-agent-tools';

/** What the writer reads of a tool. Every ToolDefinition satisfies it. */
export interface AutonomyRowTool extends TemplateTool {
  /** Declared by the tools that can replace a shared file (`replacesSharedFile`). */
  replacesSharedFile?: unknown;
  /** Where the tool comes from, when known: what the screen showed before #917. */
  source?: AgentToolSource;
}

const ORDER: Record<ApprovalRuleAction, number> = {
  auto_approve: 0,
  require_approval: 1,
  block: 2,
};

function stricter(a: ApprovalRuleAction, b: ApprovalRuleAction | undefined): ApprovalRuleAction {
  return b !== undefined && ORDER[b] > ORDER[a] ? b : a;
}

/**
 * The names an agent must hold a row for: each of its tools, and the
 * shared-file setting when one of them can replace a shared file.
 */
export function autonomyRowNames(tools: readonly AutonomyRowTool[]): string[] {
  const names = new Set(tools.map((t) => t.name));
  if (tools.some((t) => t.replacesSharedFile !== undefined)) names.add(REPLACE_SHARED_FILE_SETTING);
  return [...names];
}

interface RowContext {
  level: AutonomyLevel;
  rules: readonly ApprovalRuleForChain[];
  agentId: string;
  entityId: string;
}

/**
 * The value the screen showed before #917 for a tool without a row, made no
 * wider than what the gate applied — the first write's value.
 *
 * The gate applied the template (`templateAutonomy`: the same template rules,
 * then the tool's posture relaxed by the level). The screen showed something
 * else in two places, and showed it as the setting:
 *
 *   - an MCP tool: the server's row, or Ask first without one — while
 *     `destructive_gate` and `fully_autonomous` let a non-destructive MCP tool
 *     run;
 *   - a connector operation that asks by itself (⚠ in the Connectors tab):
 *     Ask first — while the same two levels let it run.
 *
 * Everywhere else (built-in tools, delivery, Run commands, which showed no
 * choice) the gate's value is written. The stricter of the two is kept: the
 * row is what the owner saw, and never more permissive than what ran.
 */
export function valueShownBefore917(tool: AutonomyRowTool, ctx: RowContext): ApprovalRuleAction {
  const applied = templateAutonomy(tool, ctx);
  const namespace = namespaceOfToolName(tool.name);
  if (namespace !== null) {
    const serverRow = ctx.rules.find(
      (r) =>
        r.agentId === ctx.agentId &&
        r.toolName === `${namespace}__*` &&
        !r.conditionJson?.workspacePath,
    );
    return stricter(applied, serverRow?.action ?? 'require_approval');
  }
  if (tool.source === 'connector' && tool.defaultApproval === 'require_approval') {
    return stricter(applied, 'require_approval');
  }
  return applied;
}

/**
 * The shared-file setting's first value (#917): what applied before, when the
 * check lived inside file_write, file_edit, file_move and generate_speech.
 *
 * It applied to a tool when no rule named it (an explicit rule, any action,
 * skipped it) and the level was not `fully_autonomous`. When the agent's tools
 * agreed, their common answer is kept. When an explicit rule made them
 * DIFFER — a rule on one of them, or a rule only in some folder — Ask first is
 * chosen, never the wider answer, and the agent is reported (`differed`).
 */
export function sharedFileShownBefore917(
  tools: readonly AutonomyRowTool[],
  ctx: RowContext,
): { value: ApprovalRuleAction; differed: boolean } {
  const replacing = tools.filter((t) => t.replacesSharedFile !== undefined);
  const answers = new Set<'on' | 'off' | 'mixed'>();
  for (const t of replacing) {
    const named = ctx.rules.some(
      (r) => r.agentId === ctx.agentId && r.toolName === t.name && !!r.conditionJson?.workspacePath,
    );
    const plain =
      explainApprovalRules(
        ctx.rules.filter((r) => !r.conditionJson?.workspacePath),
        t.name,
        ctx.agentId,
        ctx.entityId,
      ).length > 0 || explainTemplateRules(ctx.rules, t.name, ctx.agentId, ctx.entityId).length > 0;
    if (named && !plain) answers.add('mixed');
    else if (plain) answers.add('off');
    else answers.add(ctx.level === 'fully_autonomous' ? 'off' : 'on');
  }
  if (answers.size === 1 && answers.has('off')) return { value: 'auto_approve', differed: false };
  if (answers.size === 1 && answers.has('on'))
    return { value: 'require_approval', differed: false };
  if (answers.size === 0) return { value: sharedFileLevelTemplate(ctx.level), differed: false };
  return { value: 'require_approval', differed: true };
}

async function readEntity(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<{ level: AutonomyLevel; firstWrite: boolean }> {
  const [row] = await db
    .select({ rootGrants: entities.rootGrants, writtenAt: entities.autonomyRowsWrittenAt })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!row) throw new Error(`autonomy rows: workspace ${entityId} not found`);
  return { level: parseRootGrants(row.rootGrants).autonomy, firstWrite: row.writtenAt === null };
}

async function readRules(db: AnyDrizzleDb, entityId: string): Promise<ApprovalRuleForChain[]> {
  const rows = await db.select().from(approvalRules).where(eq(approvalRules.entityId, entityId));
  return rows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    action: r.action as ApprovalRuleAction,
    agentId: r.agentId,
    entityId: r.entityId,
    conditionJson: (r.conditionJson ?? null) as ApprovalRuleForChain['conditionJson'],
  }));
}

export interface WrittenAutonomyRows {
  /** The names whose row this call wrote, with the value written. */
  written: Array<{ toolName: string; action: ApprovalRuleAction }>;
  /** First write only: the shared-file setting chose Ask first because the tools differed. */
  sharedFileDiffered: boolean;
}

/**
 * Write the rows `agentId` is missing for `tools`. Never touches an existing
 * row. Safe under concurrency: a row written meanwhile by another caller
 * wins (`ON CONFLICT DO NOTHING`), and nothing is ever overwritten.
 */
export async function writeMissingAutonomyRows(
  db: AnyDrizzleDb,
  params: { entityId: string; agentId: string; tools: readonly AutonomyRowTool[] },
): Promise<WrittenAutonomyRows> {
  const { entityId, agentId, tools } = params;
  const { level, firstWrite } = await readEntity(db, entityId);
  const rules = await readRules(db, entityId);
  const ctx: RowContext = { level, rules, agentId, entityId };
  const held = new Set(
    rules
      .filter((r) => r.agentId === agentId && !r.conditionJson?.workspacePath)
      .map((r) => r.toolName),
  );

  // ONE insert for every missing row of this agent, the shared-file setting
  // included: on a first write the setting is read from the rules that
  // existed BEFORE it, and a row this writer wrote must never pass for an
  // owner's rule on a later call.
  const written: WrittenAutonomyRows['written'] = [];
  let sharedFileDiffered = false;
  for (const name of autonomyRowNames(tools)) {
    if (held.has(name) || isPatternToolName(name)) continue;
    let action: ApprovalRuleAction;
    if (name === REPLACE_SHARED_FILE_SETTING) {
      if (firstWrite) {
        const before = sharedFileShownBefore917(tools, ctx);
        action = before.value;
        sharedFileDiffered = before.differed;
      } else {
        action = templateAutonomy({ name, riskLevel: 'write' }, ctx);
      }
    } else {
      const tool = tools.find((t) => t.name === name)!;
      action = firstWrite ? valueShownBefore917(tool, ctx) : templateAutonomy(tool, ctx);
    }
    written.push({ toolName: name, action });
  }
  if (written.length === 0) return { written, sharedFileDiffered };

  const inserted = await db
    .insert(approvalRules)
    .values(written.map((w) => ({ entityId, agentId, toolName: w.toolName, action: w.action })))
    .onConflictDoNothing({ target: APPROVAL_ROW_KEY })
    .returning({ toolName: approvalRules.toolName, action: approvalRules.action });
  return {
    written: inserted.map((r) => ({
      toolName: r.toolName,
      action: r.action as ApprovalRuleAction,
    })),
    sharedFileDiffered:
      sharedFileDiffered && inserted.some((r) => r.toolName === REPLACE_SHARED_FILE_SETTING),
  };
}

/**
 * Write the rows an agent is missing, for every tool it holds in its widest
 * job (`WIDEST_PLACEMENT`). The one call every "a tool became available" path
 * makes. Throws for an unknown agent.
 */
export async function syncAgentAutonomyRows(
  db: AnyDrizzleDb,
  agentId: string,
): Promise<WrittenAutonomyRows> {
  const [agent] = await db
    .select({ entityId: agents.entityId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent?.entityId) throw new Error(`autonomy rows: agent ${agentId} not found`);
  const tools = await resolveAgentTools(db, agentId, WIDEST_PLACEMENT);
  return writeMissingAutonomyRows(db, { entityId: agent.entityId, agentId, tools });
}

/**
 * At the runner's boot: every agent of every workspace gets its missing rows.
 * A workspace whose first write is not done yet is then marked done
 * (`autonomy_rows_written_at`), so later rows follow the level.
 *
 * One agent that fails to resolve (a broken MCP cache, a missing adapter) is
 * logged loud and the others go on; its workspace stays unmarked, so the next
 * boot does its first write again, with the same values.
 */
export async function writeAutonomyRowsAtBoot(
  db: AnyDrizzleDb,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<{ written: number; failed: number }> {
  const all = await db
    .select({ id: agents.id, slug: agents.slug, entityId: agents.entityId })
    .from(agents);
  const failedEntities = new Set<string>();
  let written = 0;
  let failed = 0;
  for (const agent of all) {
    if (!agent.entityId) continue;
    try {
      const result = await syncAgentAutonomyRows(db, agent.id);
      written += result.written.length;
      if (result.sharedFileDiffered) {
        log(
          `[autonomy] AUTONOMY_SHARED_FILE_ASK_FIRST agent=${agent.slug} (${agent.id}): a rule ` +
            'made file_write, file_edit, file_move and generate_speech differ; the shared-file ' +
            'setting starts on Ask first',
        );
      }
    } catch (err) {
      failed += 1;
      failedEntities.add(agent.entityId);
      console.error(
        `[autonomy] AUTONOMY_ROWS_FAILED agent=${agent.slug} (${agent.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const pending = await db
    .select({ id: entities.id })
    .from(entities)
    .where(isNull(entities.autonomyRowsWrittenAt));
  for (const e of pending) {
    if (failedEntities.has(e.id)) continue;
    await db
      .update(entities)
      .set({ autonomyRowsWrittenAt: sql`now()` })
      .where(and(eq(entities.id, e.id), isNull(entities.autonomyRowsWrittenAt)));
  }
  if (written > 0 || failed > 0) {
    log(`[autonomy] wrote ${written} autonomy row(s) at boot; ${failed} agent(s) failed`);
  }
  return { written, failed };
}

/**
 * "Apply to all agents" (#917): the workspace autonomy level, written to
 * every agent's rows — each tool and the shared-file setting, with the value
 * the level gives it. The template rules (a server's setting, a rule for every
 * agent or every tool) are removed: after this, the level is the template.
 * Rows confined to one folder are kept: they say "in this folder", which no
 * level says.
 *
 * Returns how many rows changed value.
 */
export async function applyAutonomyLevelToAll(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<{ changed: number }> {
  const { level } = await readEntity(db, entityId);
  const members = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.entityId, entityId));
  // Each agent's tools first, outside the transaction: resolving reads many
  // tables, and the rows it lacks are written by the same writer as always.
  const plans: Array<{ agentId: string; values: Map<string, ApprovalRuleAction> }> = [];
  for (const m of members) {
    const tools = await resolveAgentTools(db, m.id, WIDEST_PLACEMENT);
    const values = new Map<string, ApprovalRuleAction>();
    for (const t of tools) values.set(t.name, levelTemplate(t, level));
    if (tools.some((t) => t.replacesSharedFile !== undefined)) {
      values.set(REPLACE_SHARED_FILE_SETTING, sharedFileLevelTemplate(level));
    }
    plans.push({ agentId: m.id, values });
  }

  let changed = 0;
  await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.entityId, entityId));
    // The template rules go: the level is the template now.
    for (const r of current) {
      if (r.agentId === null || isPatternToolName(r.toolName)) {
        await tx.delete(approvalRules).where(eq(approvalRules.id, r.id));
      }
    }
    for (const plan of plans) {
      for (const [toolName, action] of plan.values) {
        const existing = current.find(
          (r) =>
            r.agentId === plan.agentId &&
            r.toolName === toolName &&
            (r.conditionFolder ?? '') === '',
        );
        if (existing?.action === action) continue;
        changed += 1;
        await tx
          .insert(approvalRules)
          .values({ entityId, agentId: plan.agentId, toolName, action })
          .onConflictDoUpdate({
            target: APPROVAL_ROW_KEY,
            set: { action, updatedAt: new Date() },
          });
      }
    }
  });
  return { changed };
}

/**
 * The value the template gives each of these BUILT-IN tools for this agent
 * today — for a caller that puts rows BACK to the level (the read-only preset
 * turned off). A tool the agent does not hold today is valued from its
 * registered definition, as it will be on arrival: valuing it from a guess
 * would hand `run_command` Autonomous to an agent that later gets a shell.
 * Throws for a name the registry does not hold.
 */
export async function templateValuesFor(
  db: AnyDrizzleDb,
  agentId: string,
  toolNames: readonly string[],
): Promise<Record<string, ApprovalRuleAction>> {
  const [agent] = await db
    .select({ entityId: agents.entityId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent?.entityId) throw new Error(`autonomy rows: agent ${agentId} not found`);
  const { level } = await readEntity(db, agent.entityId);
  const rules = await readRules(db, agent.entityId);
  const tools = await resolveAgentTools(db, agentId, WIDEST_PLACEMENT);
  const ctx: RowContext = { level, rules, agentId, entityId: agent.entityId };
  const out: Record<string, ApprovalRuleAction> = {};
  const registry = createToolRegistry();
  registerBuiltins(registry);
  for (const name of toolNames) {
    const tool = tools.find((t) => t.name === name) ?? registry.get(name);
    if (!tool) throw new Error(`autonomy rows: ${name} is not a built-in tool`);
    out[name] = templateAutonomy(tool, ctx);
  }
  return out;
}
