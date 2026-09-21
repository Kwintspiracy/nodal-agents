// purpose-exposure.ts — ce que le modèle voit de `purpose`, outil par outil,
// pour CE job.
//
// Séparé de `purpose.ts` pour une raison mécanique : ce module lit
// `matchApprovalRule`, qui vit dans `execute.ts`, lequel importe le REFUS de
// `purpose.ts`. Les trois fichiers forment une chaîne, jamais un cycle.
//
// Ce que ce module décide est une AFFORDANCE, pas la règle. La règle est
// prononcée par `refuseWithoutStatedPurpose` sur l'appel réel. La distinction
// compte : la liste d'outils est bâtie une fois, au démarrage du job, alors que
// la posture effective d'un appel peut encore bouger dans le gate (relaxation
// d'autonomie, neutralisation d'un wildcard `*` auto_approve sur un outil qui
// exécute du code, plancher catastrophique). Un désaccord est donc possible, et
// il est sans danger DANS CE SENS-LÀ : si la posture durcit après coup, le champ
// n'était qu'optionnel, le gate refuse l'appel, et le modèle rappelle l'outil
// avec la phrase — le champ est dans son schéma, décrit. Ce qui ne peut pas
// arriver, c'est qu'une ligne d'approbation muette soit créée.

import type { z } from 'zod';
import { matchApprovalRule } from './execute';
import { withStatedPurpose } from './purpose';
import type { ApprovalRule, ToolDefinition } from './types';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

export interface PurposeExposureContext {
  approvalRules: readonly ApprovalRule[];
  agentId: string;
  entityId: string;
}

/**
 * Vrai quand, pour CET agent, l'outil demande l'approbation d'une personne
 * avant de s'exécuter — par une règle qui le nomme (ou un wildcard), ou par sa
 * propre posture `defaultApproval`.
 *
 * `block` rend faux : un outil interdit ne demande rien, il refuse.
 */
export function asksForApprovalFirst(tool: AnyTool, ctx: PurposeExposureContext): boolean {
  const rule = matchApprovalRule(
    ctx.approvalRules as ApprovalRule[],
    tool.name,
    ctx.agentId,
    ctx.entityId,
  );
  const action = rule?.action ?? tool.defaultApproval;
  return action === 'require_approval';
}

/**
 * Poser `purpose` sur toute la liste d'outils d'un job.
 *
 * `required` pour un outil « on demande d'abord », optionnel pour les autres —
 * un outil autonome peut être gaté plus tard par une règle posée en cours de
 * route, et un champ optionnel lui laisse la phrase à portée de main.
 *
 * Les outils qui POSENT une question (`asksUser`) sont laissés tels quels : leur
 * entrée EST le message à la personne, et la carte rend cette question.
 */
export function exposeStatedPurpose(
  tools: readonly AnyTool[],
  ctx: PurposeExposureContext,
): AnyTool[] {
  return tools.map((tool) =>
    tool.asksUser === true
      ? tool
      : withStatedPurpose(tool, { required: asksForApprovalFirst(tool, ctx) }),
  );
}
