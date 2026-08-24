// approvals/rules.ts — écrire une règle d'approbation depuis le runner.
//
// Jusqu'au lot approbations (24/08), seul le web écrivait dans approval_rules
// (setAgentApprovalRuleAction, drizzle inline). Le bouton « 🔁 Always allow »
// des cartes canal a besoin du même geste côté runner : même upsert, même
// contrainte unique (entity, agent, tool) NULLS NOT DISTINCT — une ligne par
// triplet, l'action écrase la précédente.

import { approvalRules } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

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
