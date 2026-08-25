// approvals/rules.ts — écrire une règle d'approbation depuis le runner.
//
// Jusqu'au lot approbations (24/08), seul le web écrivait dans approval_rules
// (setAgentApprovalRuleAction, drizzle inline). Le bouton « 🔁 Always allow »
// des cartes canal a besoin du même geste côté runner : même upsert, même
// contrainte unique (entity, agent, tool) NULLS NOT DISTINCT — une ligne par
// triplet, l'action écrase la précédente.

import { and, eq, approvalRules, entities } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

export type RuleTarget = { entityId: string; agentId: string; toolName: string };

/**
 * L'action de la règle EXACTE (entité, agent, outil), ou null si aucune ligne
 * n'existe. Sert à capturer l'état d'avant pour pouvoir le restaurer si la
 * suite échoue (revue P0 du 25/08).
 */
export async function getApprovalRule(db: RunnerDeps['db'], t: RuleTarget): Promise<string | null> {
  const [row] = await db
    .select({ action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, t.entityId),
        eq(approvalRules.agentId, t.agentId),
        eq(approvalRules.toolName, t.toolName),
      ),
    )
    .limit(1);
  return row?.action ?? null;
}

/**
 * Remet la règle dans l'état capturé par getApprovalRule : son action
 * précédente, ou la SUPPRESSION quand il n'y avait pas de ligne. Best-effort —
 * un rollback qui échoue est loggué, jamais propagé (on est déjà sur un
 * chemin d'échec).
 */
export async function restoreApprovalRule(
  db: RunnerDeps['db'],
  t: RuleTarget & { previousAction: string | null },
): Promise<void> {
  try {
    const where = and(
      eq(approvalRules.entityId, t.entityId),
      eq(approvalRules.agentId, t.agentId),
      eq(approvalRules.toolName, t.toolName),
    );
    if (t.previousAction === null) {
      await db.delete(approvalRules).where(where);
      return;
    }
    await db
      .update(approvalRules)
      .set({ action: t.previousAction, updatedAt: new Date() })
      .where(where);
  } catch (err) {
    console.error('[approvals/rules] rollback failed:', err);
  }
}

/** Le frein d'urgence du workspace est-il enclenché ? */
export async function isAutoRunPaused(db: RunnerDeps['db'], entityId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ autoRunPaused: entities.autoRunPaused })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    return row?.autoRunPaused === true;
  } catch {
    return false;
  }
}

/**
 * Pose (ou remplace) la règle auto_approve d'UN outil pour UN agent. Portée
 * agent uniquement — l'élargissement « tous mes agents » reste un geste du
 * dashboard, où la confirmation peut l'expliquer correctement.
 */
export async function upsertAutoApproveRule(
  db: RunnerDeps['db'],
  args: { entityId: string; agentId: string; toolName: string },
): Promise<void> {
  await db
    .insert(approvalRules)
    .values({
      entityId: args.entityId,
      agentId: args.agentId,
      toolName: args.toolName,
      action: 'auto_approve',
    })
    .onConflictDoUpdate({
      target: [approvalRules.entityId, approvalRules.agentId, approvalRules.toolName],
      set: { action: 'auto_approve', updatedAt: new Date() },
    });
}
