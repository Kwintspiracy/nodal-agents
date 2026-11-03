// autonomy-rows-fixture.ts — the rows an agent holds in a test (#917).
//
// Since #917 the gate applies the agent's ROW for each tool and refuses a call
// whose tool has none: there is no default left to fall back on. A test that
// is not about approval still has to hand the gate the rows the product would
// have written, exactly as the runner does (one row per tool the agent holds,
// and the shared-file setting).
//
// `autonomousRows` gives them all on Autonomous: the setting a test about
// something else (a card, a write record, a checkpoint) runs under. A test
// about approval writes its own rows, value by value.

import { REPLACE_SHARED_FILE_SETTING, type AutonomyLevel } from '@nodal-agents/shared';
import { templateAutonomy, type TemplateTool } from '../autonomy-template';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';
import type { ApprovalRule } from '../types';

let builtins: string[] | null = null;

/** Every built-in this build registers. */
export function builtinToolNames(): string[] {
  if (!builtins) {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    builtins = registry.list().map((t) => t.name);
  }
  return builtins;
}

/** One row of `agentId` for `toolName`. */
export function aRow(
  toolName: string,
  action: ApprovalRule['action'],
  scope: { agentId: string; entityId: string },
): ApprovalRule {
  return {
    id: `row-${toolName}`,
    toolName,
    action,
    agentId: scope.agentId,
    entityId: scope.entityId,
  };
}

/**
 * The rows the product writes for `tools`, and for the shared-file setting,
 * when they arrive under `level` (`templateAutonomy`, with `rules` as the
 * template rules), placed after the case's own `rules` and before Autonomous
 * rows for everything else: what an agent holds in a test about one tool's
 * posture. The case's rows come first, so they win.
 */
export function rowsAsWritten(
  scope: { agentId: string; entityId: string },
  tools: readonly TemplateTool[],
  level: AutonomyLevel = 'propose_confirm',
  rules: readonly ApprovalRule[] = [],
): ApprovalRule[] {
  const ctx = { level, rules, ...scope };
  return [
    ...rules,
    ...tools.map((t) => aRow(t.name, templateAutonomy(t, ctx), scope)),
    aRow(
      REPLACE_SHARED_FILE_SETTING,
      templateAutonomy({ name: REPLACE_SHARED_FILE_SETTING, riskLevel: 'write' }, ctx),
      scope,
    ),
    ...autonomousRows(scope),
  ];
}

/**
 * Autonomous rows for every built-in, the shared-file setting, and the extra
 * tool names a test defines itself.
 */
export function autonomousRows(
  scope: { agentId: string; entityId: string },
  extra: readonly string[] = [],
): ApprovalRule[] {
  return [...new Set([...builtinToolNames(), REPLACE_SHARED_FILE_SETTING, ...extra])].map((name) =>
    aRow(name, 'auto_approve', scope),
  );
}
