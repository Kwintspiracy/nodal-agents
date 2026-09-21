// approval-rules-chain.ts — the ORDER in which approval rules are consulted,
// as one pure function, so the card can show exactly what the gate did.
//
// WHY this exists
// ---------------
// Issue #346: an owner answered "Always for this server" on a tool, the rule was
// written, and the very same tool kept asking — an entity-wide rule NAMING that
// tool had been sitting there since 2026-09-18, and a tool-specific rule beats a
// wildcard whatever its scope. The precedence was right. The card just never
// said which rule was actually deciding.
//
// So the precedence stops being a `.find()` chain buried in the gate and becomes
// a value: the ordered list of rules that match this call, the first one marked
// as the winner. `matchApprovalRule` (packages/tools/src/execute.ts) DERIVES its
// answer from this list — one truth, not two copies that drift.
//
// It lives in @nodal-agents/shared rather than @nodal-agents/tools because the
// dashboard renders it and does not depend on the tools package. Same move, and
// same reason, as the command classifiers (see the re-export note in
// packages/tools/src/index.ts).

import type { ApprovalRuleAction } from './enums';

/**
 * A rule's `condition_json`. Today it carries at most a workspace path:
 * "auto-approve this tool for this agent WHILE IT WORKS IN THIS FOLDER".
 *
 * An empty object (the historical value of every row) means no condition, which
 * is why the column needed no migration.
 */
export interface ApprovalRuleCondition {
  /** Absolute path of the agent workspace this rule is confined to. */
  workspacePath?: string;
}

/** The subset of an `approval_rules` row this module needs. */
export interface ApprovalRuleForChain {
  id: string;
  toolName: string;
  action: ApprovalRuleAction;
  /** `null` = the rule binds every agent of the entity ("Everyone"). */
  agentId: string | null;
  entityId: string | null;
  conditionJson?: ApprovalRuleCondition | null;
}

/** One of the agent's attached folders, as `agent_workspaces` stores it. */
export interface ChainWorkspace {
  label: string;
  path: string;
}

/** How precisely a rule names the call it applies to. Lower wins. */
export type ApprovalRuleTier =
  /** Agent + exact tool, AND confined to a folder this job works in. */
  | 'agent-tool-in-folder'
  /** Agent + exact tool. */
  | 'agent-tool'
  /** Everyone + exact tool. */
  | 'entity-tool'
  /** Agent + `<server>__*`. */
  | 'agent-server'
  /** Everyone + `<server>__*`. */
  | 'entity-server'
  /** Agent + `*`. */
  | 'agent-all'
  /** Everyone + `*`. */
  | 'entity-all';

export interface ExplainedApprovalRule {
  id: string;
  /**
   * Position of this rule in the array handed in.
   *
   * `matchApprovalRule` reads it to hand back the ORIGINAL row. Going through
   * the id instead looked cleaner and was wrong: nothing in the type says ids
   * are distinct, and two fixtures sharing one made the gate return the first
   * rule of the array rather than the winning one.
   */
  sourceIndex: number;
  toolName: string;
  action: ApprovalRuleAction;
  agentId: string | null;
  /** 'agent' = this agent only, 'entity' = every agent ("Everyone"). */
  scope: 'agent' | 'entity';
  tier: ApprovalRuleTier;
  /** The folder this rule is confined to, when it carries that condition. */
  workspacePath: string | null;
  /** That folder's label, when the caller supplied the agent's workspaces. */
  workspaceLabel: string | null;
  /** True on the FIRST rule only — the one the gate obeys. */
  wins: boolean;
}

/**
 * The MCP server namespace of a tool name, or null for a built-in.
 *
 * `<serverPrefix>__<tool>` is the MCP naming convention; nothing else in the
 * product puts `__` in a tool name.
 */
export function namespaceOfToolName(toolName: string): string | null {
  const i = toolName.indexOf('__');
  return i > 0 ? toolName.slice(0, i) : null;
}

/**
 * Normalise an absolute path for comparison.
 *
 * Separators are unified, `.` and `..` segments collapsed, trailing separators
 * dropped, and the whole thing lowercased on Windows — `D:\APPS\Nodal` and
 * `d:/apps/nodal/` are the same folder, and a condition that failed on a
 * backslash would silently stop applying (invariant #4: never fail quietly).
 *
 * A bare drive prefix is kept whole: `C:` and `D:` are different places, and
 * collapsing both to an empty string would have made them equal.
 *
 * Written here rather than with `node:path` on purpose: this module is imported
 * by the dashboard, and dragging a Node builtin into that graph is how a client
 * bundle breaks.
 */
export function normaliseWorkspacePath(
  raw: string,
  platform: string = typeof process === 'undefined' ? 'linux' : process.platform,
): string {
  const unified = raw.replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/');
  // `C:` et `D:` sont des chemins DIFFERENTS, et la boucle ci-dessous les
  // reduisait tous deux a la chaine vide faute de separateur (revue Reviewer C,
  // passe 1). Le prefixe de lecteur est mis de cote avant le decoupage.
  const drive = /^([A-Za-z]:)(\/|$)/.exec(unified);
  const body = drive ? unified.slice(2) : unified;
  const out: string[] = [];
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = (drive ? `${drive[1]}/` : isAbsolute ? '/' : '') + out.join('/');
  return platform === 'win32' ? joined.toLowerCase() : joined;
}

/** Whether `workspaces` contains the folder a conditioned rule names. */
export function workspaceMatches(
  workspacePath: string,
  workspaces: readonly ChainWorkspace[] | undefined,
  platform?: string,
): boolean {
  if (!workspaces || workspaces.length === 0) return false;
  const wanted = normaliseWorkspacePath(workspacePath, platform);
  return workspaces.some((w) => normaliseWorkspacePath(w.path, platform) === wanted);
}

function readCondition(rule: ApprovalRuleForChain): string | null {
  const raw = rule.conditionJson?.workspacePath;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/**
 * Every rule that applies to one call, most specific first.
 *
 * The order is the gate's order, and the only copy of it:
 *
 *   0. agent + exact tool, confined to a folder this job is working in
 *   1. agent + exact tool
 *   2. Everyone + exact tool
 *   3. agent + `<server>__*`
 *   4. Everyone + `<server>__*`
 *   5. agent + `*`
 *   6. Everyone + `*`
 *
 * A rule carrying a folder condition that this job does NOT work in is left out
 * entirely: it does not apply, so it must not be shown as overridden either —
 * the search simply continues at the next tier. A conditioned rule that DOES
 * apply is the most precise statement the owner ever made about this call, so
 * it comes ahead of everything, including an unconditioned rule on the same
 * (agent, tool) pair. In practice the unique constraint on
 * (entity_id, agent_id, tool_name) means only one of those two can exist at a
 * time; the order is stated anyway so it never has to be guessed.
 *
 * Returns `[]` when nothing matches — the caller then falls back to the tool's
 * own default posture, which is what the card calls "Tool default".
 */
export function explainApprovalRules(
  rules: readonly ApprovalRuleForChain[],
  toolName: string,
  agentId: string,
  entityId: string,
  workspaces?: readonly ChainWorkspace[],
  platform?: string,
): ExplainedApprovalRule[] {
  const namespace = namespaceOfToolName(toolName);
  const serverPattern = namespace === null ? null : `${namespace}__*`;

  const forAgent = (r: ApprovalRuleForChain) => r.agentId === agentId;
  const forEveryone = (r: ApprovalRuleForChain) => r.agentId === null && r.entityId === entityId;

  type Tier = { tier: ApprovalRuleTier; pick: (r: ApprovalRuleForChain) => boolean };
  const tiers: Tier[] = [
    { tier: 'agent-tool', pick: (r) => r.toolName === toolName && forAgent(r) },
    { tier: 'entity-tool', pick: (r) => r.toolName === toolName && forEveryone(r) },
    ...(serverPattern === null
      ? []
      : ([
          {
            tier: 'agent-server',
            pick: (r: ApprovalRuleForChain) => r.toolName === serverPattern && forAgent(r),
          },
          {
            tier: 'entity-server',
            pick: (r: ApprovalRuleForChain) => r.toolName === serverPattern && forEveryone(r),
          },
        ] satisfies Tier[])),
    { tier: 'agent-all', pick: (r) => r.toolName === '*' && forAgent(r) },
    { tier: 'entity-all', pick: (r) => r.toolName === '*' && forEveryone(r) },
  ];

  const ordered: ExplainedApprovalRule[] = [];

  for (const { tier, pick } of tiers) {
    const conditioned: ExplainedApprovalRule[] = [];
    const plain: ExplainedApprovalRule[] = [];
    for (const [index, rule] of rules.entries()) {
      if (!pick(rule)) continue;
      const condition = readCondition(rule);
      if (condition !== null && !workspaceMatches(condition, workspaces, platform)) continue;
      const label =
        condition === null
          ? null
          : ((workspaces ?? []).find(
              (w) =>
                normaliseWorkspacePath(w.path, platform) ===
                normaliseWorkspacePath(condition, platform),
            )?.label ?? null);
      const explained: ExplainedApprovalRule = {
        id: rule.id,
        sourceIndex: index,
        toolName: rule.toolName,
        action: rule.action,
        agentId: rule.agentId,
        scope: rule.agentId === null ? 'entity' : 'agent',
        tier: condition !== null && tier === 'agent-tool' ? 'agent-tool-in-folder' : tier,
        workspacePath: condition,
        workspaceLabel: label,
        wins: false,
      };
      (condition !== null ? conditioned : plain).push(explained);
    }
    // Conditionnee d'abord, A L'INTERIEUR de son tier, jamais au-dessus des
    // autres. Hisser toute regle conditionnee en tete de chaine ouvrait une
    // elevation de privilege : un joker conditionne battait alors un `block`
    // pose sur l'agent et l'outil exact (revue Reviewer C, passe 1). Sur le
    // tier qui compte - agent + outil exact, deja le plus haut - l'effet voulu
    // est le meme, et la contrainte d'unicite fait de toute facon que les deux
    // formes ne coexistent pas.
    ordered.push(...conditioned, ...plain);
  }

  if (ordered[0]) ordered[0].wins = true;
  return ordered;
}
