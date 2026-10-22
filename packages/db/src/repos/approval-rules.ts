// repos/approval-rules.ts — les règles d'approbation que le tableau de bord écrit.
//
// Sorties des actions (apps/web/src/lib/actions.ts) pour qu'un autre appelant
// écrive la MÊME règle, avec la MÊME garde : le banc v2 applique sa
// configuration à son instance par ces fonctions (règle 11). La garde
// d'accès (le propriétaire seul hors local-trust) reste dans l'action.

import { and, eq, inArray } from 'drizzle-orm';
import type { ApprovalRuleCondition } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { approvalRules } from '../schema/approvals.ts';

/**
 * Depuis « Approve for this project » (#346), une regle agent+outil peut
 * porter `condition_json.workspacePath` : « approuve, mais seulement quand
 * l'agent travaille la ». Les surfaces qui ecrivent une regle auto_approve
 * ailleurs (les bascules Yolo, l'ecran d'autonomie) ne connaissent pas cette
 * condition et l'ecrasaient : une permission posee comme « seulement ici »
 * devenait valable partout, en silence (revue Reviewer C, passe 1).
 *
 * Seul le sens PERMISSIF est refuse. Passer la meme regle a `require_approval`
 * ou `block`, ou la supprimer, retire la condition mais RESTREINT : rien a
 * proteger la.
 *
 * Rend le message d'erreur, ou null quand l'ecriture peut passer.
 */
export async function refuseGlobalGrantOverFolderRule(
  tx: Pick<AnyDrizzleDb, 'select'>,
  entityId: string,
  agentId: string,
  toolName: string,
): Promise<string | null> {
  const [existing] = await tx
    .select({ action: approvalRules.action, conditionJson: approvalRules.conditionJson })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, entityId),
        eq(approvalRules.agentId, agentId),
        eq(approvalRules.toolName, toolName),
      ),
    )
    // VERROU. Lire puis ecrire hors transaction laissait une fenetre : un
    // second geste concurrent passait le garde et ecrasait la regle de dossier
    // par une permission globale (revue Reviewer C, passe 2). `FOR UPDATE`
    // tient la ligne jusqu'au commit de l'appelant, qui ouvre donc TOUJOURS une
    // transaction autour de ce garde et de son ecriture.
    .for('update');
  const folder = (existing?.conditionJson as ApprovalRuleCondition | null)?.workspacePath;
  if (!existing || typeof folder !== 'string') return null;
  if (existing.action === 'auto_approve') {
    return (
      `${toolName} is already approved for this agent only inside ${folder}. ` +
      'Change that rule on the approval card before allowing it everywhere.'
    );
  }
  // A Block or Ask rule confined to a folder is not a grant, but replacing it
  // with a grant everywhere removes it AND widens the tool (review of PR #481,
  // Reviewer A, P2). Refused the same way: the owner removes it first.
  return (
    `${toolName} has a rule for this agent inside ${folder} (${existing.action === 'block' ? 'Block' : 'Ask for approval'}). ` +
    'Remove that rule before allowing it everywhere.'
  );
}

export type RunCommandRuleAction = 'auto_approve' | 'require_approval' | 'block';

/**
 * La ligne « Run commands » de l'onglet Autonomie (#468) : une des trois
 * actions, ou `null` qui retire la règle (l'autonomie de l'espace décide).
 *
 * Supprimer puis insérer DANS une transaction (R2, audit #2) : la contrainte
 * UNIQUE(entity_id, agent_id, tool_name) ferait échouer deux gestes
 * concurrents au lieu de laisser une ligne propre. « Run without asking »
 * accorde l'outil PARTOUT : une règle déjà confinée à un dossier serait élargie
 * en silence (Reviewer C, passe 1), donc refusée en nommant le dossier ; la
 * garde verrouille la ligne dans la même transaction (passe 2).
 *
 * L'agent doit appartenir à l'espace : l'appelant l'a vérifié.
 */
export async function setRunCommandRuleRepo(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  action: RunCommandRuleAction | null,
): Promise<{ refused: string } | { ok: true }> {
  const refused = await db.transaction(async (tx) => {
    if (action === 'auto_approve') {
      const message = await refuseGlobalGrantOverFolderRule(tx, entityId, agentId, 'run_command');
      if (message) return message;
    }

    await tx
      .delete(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, entityId),
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'run_command'),
        ),
      );

    if (action !== null) {
      await tx
        .insert(approvalRules)
        .values({ entityId, agentId, toolName: 'run_command', action })
        .onConflictDoUpdate({
          target: [approvalRules.entityId, approvalRules.agentId, approvalRules.toolName],
          set: { action, conditionJson: {}, updatedAt: new Date() },
        });
    }
    return null;
  });
  return refused === null ? { ok: true } : { refused };
}

/**
 * Le préréglage « relecteur en lecture seule » : action='block' sur chaque
 * outil d'écriture qu'il couvre. La détection de lecture seule de code_task
 * (assertNotReadOnlyAgent, packages/tools/src/builtin/code-task/db.ts) s'appuie
 * sur l'un d'eux — file_write bloqué ⇒ le mode « write » est refusé aussi —, la
 * liste doit donc rester un sur-ensemble qui contient 'file_write'.
 */
export const READONLY_PRESET_TOOLS = [
  'file_write',
  'file_edit',
  'skill_file_write',
  'run_command',
  'run_skill_script',
] as const;

/**
 * enabled=true  → une ligne 'block' par outil (insertion groupée + onConflictDoUpdate).
 * enabled=false → retire SEULEMENT les lignes que ce préréglage aurait posées
 *                 (action='block' sur ces outils exacts) : une règle
 *                 require_approval ou auto_approve posée à la main, sur
 *                 run_command par exemple, est un choix à part et survit.
 *
 * Le chemin du préréglage de l'écran d'édition ET celui d'une recette
 * d'agent qui le déclare : les mêmes lignes.
 */
export async function setReadOnlyPresetRepo(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await db
      .insert(approvalRules)
      .values(
        READONLY_PRESET_TOOLS.map((toolName) => ({
          entityId,
          agentId,
          toolName,
          action: 'block' as const,
        })),
      )
      .onConflictDoUpdate({
        target: [approvalRules.entityId, approvalRules.agentId, approvalRules.toolName],
        set: { action: 'block', updatedAt: new Date() },
      });
    return;
  }
  await db
    .delete(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, entityId),
        eq(approvalRules.agentId, agentId),
        inArray(approvalRules.toolName, [...READONLY_PRESET_TOOLS]),
        eq(approvalRules.action, 'block'),
      ),
    );
}
