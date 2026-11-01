// repos/approval-rules.ts — les lignes d'autonomie que le tableau de bord écrit.
//
// Sorties des actions (apps/web/src/lib/actions.ts) pour qu'un autre appelant
// écrive la MÊME ligne, avec la MÊME garde : le banc v2 applique sa
// configuration à son instance par ces fonctions (règle 11). La garde
// d'accès (le propriétaire seul hors local-trust) reste dans l'action.
//
// Depuis #917, un agent tient UNE ligne par outil qu'il a (agent + outil exact,
// sans condition), et c'est elle que l'écran montre et que la porte applique.
// Deux autres formes vivent à côté :
//
//   - une ligne CONFINÉE À UN DOSSIER (« Approve for this project », #346) :
//     elle vaut dans ce dossier, la ligne de l'outil partout ailleurs. Elles
//     coexistent (contrainte d'unicité sur le dossier, migration 0155) ; écrire
//     l'une ne touche jamais l'autre. Le garde « une permission partout
//     n'élargit jamais en silence une règle de dossier » n'a donc plus d'objet :
//     la règle de dossier reste en place, et l'écran la montre à part ;
//   - une ligne MODÈLE, qui nomme un serveur (`<serveur>__*`), un outil pour
//     tous les agents (`agent_id` NULL) ou tous les outils (`*`) : elle donne la
//     valeur d'une ligne nouvelle (`templateAutonomy`, @nodal-agents/tools),
//     jamais une décision à l'exécution. L'écrire réécrit AUSSI, tout de suite,
//     les lignes qu'elle couvre : sinon le geste ne changerait rien de ce que
//     l'agent fait aujourd'hui, et l'écran le montrerait.

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { READONLY_PRESET_TOOLS } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { approvalRules } from '../schema/approvals.ts';

export type RunCommandRuleAction = 'auto_approve' | 'require_approval' | 'block';

/** La cible de l'upsert : une ligne par (espace, agent, outil, dossier). */
export const APPROVAL_ROW_KEY = [
  approvalRules.entityId,
  approvalRules.agentId,
  approvalRules.toolName,
  approvalRules.conditionFolder,
];

export interface SetApprovalRuleInput {
  /** L'agent depuis l'écran duquel la règle est posée ; l'appelant a vérifié qu'il est de l'espace. */
  readonly agentId: string;
  readonly toolName: string;
  /**
   * `null` RETIRE la ligne. Seulement pour une ligne qui n'est pas celle d'un
   * outil : une ligne de dossier, ou une ligne modèle. La ligne d'un outil ne
   * se retire pas (#917) : sans elle, la porte refuse l'outil.
   */
  readonly action: RunCommandRuleAction | null;
  /** `agent` : cet agent seulement ; `entity` : tout l'espace (agent_id NULL). */
  readonly scope: 'agent' | 'entity';
  /** La condition de la règle (`workspacePath`, #346), `{}` sans condition. */
  readonly conditionJson: Readonly<Record<string, string>>;
}

/** Le préfixe d'outils qu'un motif de serveur couvre : `srv__` pour `srv__*`. */
function serverPrefix(toolName: string): string | null {
  return toolName.endsWith('__*') && toolName.length > 3 ? toolName.slice(0, -1) : null;
}

/**
 * Une ligne d'autonomie, telle que l'écran la pose (la ligne d'un outil de
 * l'onglet Autonomie, celle d'un serveur, la carte « Approve for this
 * project ») : l'upsert sur (espace, agent, outil, dossier), puis, pour une
 * ligne modèle, la réécriture des lignes qu'elle couvre — dans la MÊME
 * transaction. Sortie de l'action pour que le banc (#794) pose la même ligne
 * par le même chemin ; la vérification que l'agent est de l'espace, et que le
 * dossier est l'un des siens, reste chez l'appelant.
 */
export async function setApprovalRuleRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: SetApprovalRuleInput,
): Promise<{ refused: string } | { ok: true }> {
  const { agentId, toolName, action, scope, conditionJson } = input;
  // agent_id IS NULL est la portée de l'espace (index unique NULLS NOT DISTINCT).
  const ruleAgentId = scope === 'entity' ? null : agentId;
  const condition = { ...conditionJson };
  const folder = condition['workspacePath'] ?? '';
  const prefix = serverPrefix(toolName);

  if (toolName === '*') {
    // Une règle pour TOUS les outils, c'est le niveau d'autonomie de l'espace
    // et son « Apply to all agents » (#917) : un seul chemin, qui sait ce que
    // vaut chaque outil — un outil qui exécute du code n'est jamais rendu
    // autonome par une règle qui ne le nomme pas.
    return {
      refused:
        'A rule for every tool is set with the workspace autonomy level, then "Apply to all agents".',
    };
  }
  if (action === null && scope === 'agent' && folder === '' && prefix === null) {
    return {
      refused: `${toolName} always has a setting for this agent: choose Autonomous, Ask first or Block.`,
    };
  }
  if (folder !== '' && (scope !== 'agent' || prefix !== null)) {
    return { refused: 'A folder applies to one tool of one agent.' };
  }

  await db.transaction(async (tx) => {
    const scopeMatch =
      ruleAgentId === null ? isNull(approvalRules.agentId) : eq(approvalRules.agentId, agentId);
    if (action === null) {
      await tx
        .delete(approvalRules)
        .where(
          and(
            eq(approvalRules.entityId, entityId),
            scopeMatch,
            eq(approvalRules.toolName, toolName),
            eq(approvalRules.conditionFolder, folder),
          ),
        );
      return;
    }
    // L'upsert sur la contrainte unique (DB-1, audit #2) : une seule ligne
    // canonique survit à deux gestes concurrents.
    await tx
      .insert(approvalRules)
      .values({ entityId, agentId: ruleAgentId, toolName, action, conditionJson: condition })
      .onConflictDoUpdate({
        target: APPROVAL_ROW_KEY,
        set: { action, conditionJson: condition, updatedAt: new Date() },
      });

    // Une ligne modèle réécrit les lignes qu'elle couvre (#917) : le serveur
    // pour les outils de ce serveur, « Everyone » pour la ligne de l'outil de
    // chaque agent de l'espace. Les lignes de dossier ne bougent pas : elles
    // disent « dans ce dossier », ce qu'une ligne modèle ne dit pas.
    const isTemplate = prefix !== null || ruleAgentId === null;
    if (!isTemplate) return;
    const covered =
      prefix !== null
        ? and(
            sql`starts_with(${approvalRules.toolName}, ${prefix})`,
            sql`${approvalRules.toolName} <> ${toolName}`,
          )
        : eq(approvalRules.toolName, toolName);
    await tx
      .update(approvalRules)
      .set({ action, updatedAt: new Date() })
      .where(
        and(
          eq(approvalRules.entityId, entityId),
          ruleAgentId === null ? isNotNull(approvalRules.agentId) : scopeMatch,
          eq(approvalRules.conditionFolder, ''),
          covered,
        ),
      );
  });
  return { ok: true };
}

/**
 * RETIRE la ligne d'un outil pour un agent. Réservé à qui remet une instance
 * dans l'état où il l'a trouvée (le banc, #794) : une ligne qui n'existait pas
 * avant lui ne doit pas lui survivre. L'outil, s'il est encore là, retrouve sa
 * ligne à son prochain usage, écrite par le modèle (#917) — jamais par un
 * défaut calculé à l'exécution. Aucun écran n'appelle ceci.
 */
export async function removeAgentToolRowRepo(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  toolName: string,
): Promise<void> {
  await db
    .delete(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, entityId),
        eq(approvalRules.agentId, agentId),
        eq(approvalRules.toolName, toolName),
        eq(approvalRules.conditionFolder, ''),
      ),
    );
}

/**
 * La ligne « Run commands » de l'onglet Autonomie (#468) : une des trois
 * actions. Depuis #917 elle existe toujours, comme celle de tout outil ; il
 * n'y a plus d'état « pas de règle, l'autonomie de l'espace décide ».
 *
 * L'agent doit appartenir à l'espace : l'appelant l'a vérifié.
 */
export async function setRunCommandRuleRepo(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  action: RunCommandRuleAction,
): Promise<{ refused: string } | { ok: true }> {
  return setApprovalRuleRepo(db, entityId, {
    agentId,
    toolName: 'run_command',
    action,
    scope: 'agent',
    conditionJson: {},
  });
}

// Le préréglage « relecteur en lecture seule » : sa liste vit dans
// `@nodal-agents/shared` (`readonly-preset.ts`), que l'écran lit aussi.
// Ré-exportée ici pour ceux qui la prennent au dépôt (le banc, les tests).
export { READONLY_PRESET_TOOLS };

/**
 * enabled=true  → la ligne de chaque outil du préréglage passe à 'block'.
 * enabled=false → SEULEMENT les lignes que ce préréglage aurait posées
 *                 (action='block' sur ces outils exacts) reprennent la valeur
 *                 que `restore` donne pour l'outil — celle du niveau
 *                 d'autonomie, calculée par l'appelant (`templateAutonomy`).
 *                 Une ligne Ask first ou Autonomous posée à la main, sur
 *                 run_command par exemple, est un choix à part et ne bouge pas.
 *                 Retirer la ligne, comme avant #917, ferait refuser l'outil.
 *
 * Le chemin du préréglage de l'écran d'édition ET celui d'une recette
 * d'agent qui le déclare : les mêmes lignes.
 */
export async function setReadOnlyPresetRepo(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  enabled: boolean,
  restore: Readonly<Record<string, RunCommandRuleAction>> = {},
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
        target: APPROVAL_ROW_KEY,
        set: { action: 'block', updatedAt: new Date() },
      });
    return;
  }
  await db.transaction(async (tx) => {
    for (const toolName of READONLY_PRESET_TOOLS) {
      const value = restore[toolName];
      // Une valeur manquante est un appelant qui n'a pas calculé ce qu'il
      // rend : le dire, plutôt que de laisser l'outil bloqué en silence.
      if (value === undefined) {
        throw new Error(`setReadOnlyPresetRepo: no value to restore for ${toolName}`);
      }
      await tx
        .update(approvalRules)
        .set({ action: value, updatedAt: new Date() })
        .where(
          and(
            eq(approvalRules.entityId, entityId),
            eq(approvalRules.agentId, agentId),
            eq(approvalRules.toolName, toolName),
            eq(approvalRules.conditionFolder, ''),
            eq(approvalRules.action, 'block'),
          ),
        );
    }
  });
}
