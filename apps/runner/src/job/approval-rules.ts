// job/approval-rules.ts — the approval rules a job obeys, READ FRESH.
//
// Issue #370: the list used to be read ONCE, at job start (execute.ts, step 8),
// and kept for every gate check of the job. A rule written while the job waited
// for an approval — exactly what "Approve for this project" writes, on the card
// the person is looking at — did not exist for the run it was answered on: the
// same request came back ten seconds later.
//
// So the load lives here, and execute.ts calls it in three places: at job start,
// at every turn boundary, and right after a resolved approval is replayed (both
// the in-process grace-window resume and the worker-driven one). Two indexed
// reads per turn, both filtered by entity.
//
// The `auto_run_paused` BRAKE is part of the load, not a step beside it: a
// reload that dropped the brake would turn the emergency stop into a switch
// that any reload silently releases.

import { eq, sql } from '@nodal-agents/db';
import { approvalRules, entities as entitiesTable } from '@nodal-agents/db';
import { CODE_EXECUTION_TOOL_NAMES } from '@nodal-agents/tools';
import type { ApprovalRule } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';

/**
 * The entity's approval rules for this job, brake included.
 *
 * Deterministic order (audit #2 DB-1): most specific first (agent-scoped before
 * entity-wide, exact tool before wildcard), then id as a stable tiebreaker.
 * matchApprovalRule (packages/tools/src/execute.ts) already picks the single row
 * for the tier it needs via `.find()` — the UNIQUE(entity_id, agent_id,
 * tool_name) constraint on approval_rules means at most one row can exist per
 * tier going forward — but an unordered SELECT would still make `.find()`'s
 * result depend on physical row order for any pre-existing/seeded state.
 * Sorting removes that dependency outright.
 */
export async function loadApprovalRules(
  db: RunnerDeps['db'],
  job: { entityId: string | null },
  agentRow: { id: string },
): Promise<ApprovalRule[]> {
  const entityId = job.entityId ?? '';

  const [ruleRows, brakeRows] = await Promise.all([
    db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.entityId, entityId))
      .orderBy(
        sql`${approvalRules.agentId} IS NULL`,
        sql`${approvalRules.toolName} = '*'`,
        approvalRules.id,
      ),
    db
      .select({ autoRunPaused: entitiesTable.autoRunPaused })
      .from(entitiesTable)
      .where(eq(entitiesTable.id, entityId))
      .limit(1),
  ]);

  const list: ApprovalRule[] = ruleRows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    action: (r.action ?? 'auto_approve') as ApprovalRule['action'],
    agentId: r.agentId,
    entityId: r.entityId,
    // `condition_json` travels to the gate, or a rule confined to one folder
    // ("Approve for this project", issue #346) would silently apply everywhere.
    conditionJson: (r.conditionJson ?? null) as ApprovalRule['conditionJson'],
  }));

  return applyAutoRunBrake(list, {
    autoRunPaused: brakeRows[0]?.autoRunPaused === true,
    agentId: agentRow.id,
    entityId,
  });
}

/**
 * Workspace auto-run BRAKE for code-execution tools.
 *
 * run_command, run_skill_script and skill_file_write are ALL code-execution
 * surfaces — a shell command, a bundled skill script, and a skill file whose
 * content is a script waiting to be run by one of the other two. É-2 (audit
 * sécu 2026-07-07): create_mcp/attach_mcp with a stdio transport ALSO spawn an
 * arbitrary local subprocess (npx/uvx <cmd>), and code_task spawns the owner's
 * coding CLI — same trust class as a shell.
 *
 * INVERSION du modèle à deux clés (0082, décision Quentin 24/08). L'ancien
 * lan_command_yolo était une PRÉ-CONDITION : hors local-trust, aucune règle
 * auto_approve de ces outils ne s'appliquait tant que l'owner n'avait pas
 * « débloqué » le workspace. Redondant — poser la règle par agent est DÉJÀ
 * owner-only des deux côtés (web ET la carte d'approbation) — et pénible :
 * deux serrures, une seule clé. Sa vraie valeur était le coupe-circuit, qui
 * devient son SEUL rôle : `entities.auto_run_paused` est un frein d'urgence,
 * inactif par défaut, TOUS modes d'auth confondus (un bouton rouge qui ne
 * marche qu'en LAN n'est pas un bouton rouge). Enclenché :
 *   (a) drop any auto_approve rule for these tools, and
 *   (b) if no tool-specific rule then remains, inject a require_approval rule
 *       so a blanket wildcard ('*') auto_approve can't sweep them in.
 * Nothing is deleted from the DB — releasing the brake re-arms the rules.
 * Injecting an explicit require_approval rule also matters downstream: the
 * autonomy relaxation in executeTool is guarded by `!matchedRule`, so once a
 * tool has a matched rule here, fully_autonomous/destructive_gate can no longer
 * auto-approve it either — the brake outranks autonomy.
 *
 * Exported for the tests that prove the brake survives a reload (issue #370).
 */
export function applyAutoRunBrake(
  rules: readonly ApprovalRule[],
  params: { autoRunPaused: boolean; agentId: string; entityId: string },
): ApprovalRule[] {
  let list = [...rules];
  if (!params.autoRunPaused) return list;

  // La liste vient de @nodal-agents/tools — source unique (revue sécurité du
  // 25/08). Elle était recopiée dans execute.ts : deux copies identiques, rien
  // qui verrouille l'égalité. Un outil ajouté à la garde d'autonomie mais
  // oublié dans cette copie serait resté balayable par une règle wildcard `*`
  // auto_approve alors même que le frein est enclenché.
  for (const codeTool of CODE_EXECUTION_TOOL_NAMES) {
    list = list.filter((r) => !(r.toolName === codeTool && r.action === 'auto_approve'));
    const hasToolRule = list.some((r) => r.toolName === codeTool);
    if (!hasToolRule) {
      list.push({
        id: `auto-run-pause-${codeTool}`,
        toolName: codeTool,
        action: 'require_approval',
        agentId: params.agentId,
        entityId: params.entityId,
      });
    }
  }
  return list;
}
