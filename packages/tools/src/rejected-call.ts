// rejected-call.ts — un appel que le propriétaire a refusé dans ce run ne lui
// est pas reposé à l'identique (issue #492).
//
// Job b49d7d96 (25/09/2026) : un `generate_speech` refusé, puis vingt-six
// secondes plus tard le MÊME appel — même chemin, même texte, même voix —
// avec seulement `purpose` reformulé. Le propriétaire a reçu une seconde carte
// pour une question à laquelle il venait de répondre.
//
// LA RÈGLE, pour tout outil : avant de poser une demande, la porte cherche,
// dans CE job, une demande `approval` REFUSÉE pour le même outil et la même
// entrée, `purpose` mis à part — c'est la phrase adressée à la personne, pas
// l'action. SAUF quand l'outil déclare `purpose` comme l'un de SES arguments
// (`purposeIsArgument`, un serveur MCP qui le prend) : là, un autre purpose
// est un autre appel, que le propriétaire n'a jamais vu (revue Codex de #492). Trouvée, l'appel reçoit la décision déjà prise, et aucune ligne
// n'est créée. Ce qui n'en relève pas :
//
//   - une demande EXPIRÉE : personne n'a répondu, redemander est permis
//     (`APPROVAL_EXPIRED_TOOL_RESULT` le dit déjà au modèle) ;
//   - une QUESTION (`ask_user`) : son entrée est la question elle-même, et
//     `hasAnsweredQuestion` gère sa reprise ;
//   - un AUTRE run : la décision appartient au run où elle a été prise. Si le
//     propriétaire veut qu'on réessaie, il le dit, et c'est un nouveau run.

import { approvalRequests, and, eq } from '@nodal-agents/db';
import { canonicalJson } from '@nodal-agents/shared';
import { PURPOSE_KEY } from './purpose';
import type { ToolContext } from './types';

/** La décision déjà prise sur cet appel, quand il y en a une. */
export interface PriorRejection {
  approvalRequestId: string;
  notes: string | null;
}

/**
 * L'action que décrit une entrée : tout, sauf la phrase adressée à la
 * personne. Passée par JSON d'abord, pour comparer ce que la base a gardé
 * (jsonb) à ce que la validation vient de rendre, sans que l'ordre des clés ni
 * un champ `undefined` ne fassent deux actions de la même.
 */
function actionOf(input: unknown, purposeIsArgument: boolean): string {
  const plain = JSON.parse(JSON.stringify(input ?? null)) as unknown;
  if (!purposeIsArgument && plain && typeof plain === 'object' && !Array.isArray(plain)) {
    const rest = { ...(plain as Record<string, unknown>) };
    delete rest[PURPOSE_KEY];
    return canonicalJson(rest);
  }
  return canonicalJson(plain);
}

/** Le refus déjà prononcé dans ce job sur ce même appel, ou `null`. */
export async function priorRejectionOfSameCall(
  ctx: ToolContext,
  tool: { readonly name: string; readonly purposeIsArgument?: boolean },
  input: unknown,
): Promise<PriorRejection | null> {
  const toolName = tool.name;
  const purposeIsArgument = tool.purposeIsArgument === true;
  if (!ctx.jobId) return null;
  const rows = await ctx.db
    .select({
      id: approvalRequests.id,
      toolInput: approvalRequests.toolInput,
      notes: approvalRequests.notes,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.jobId, ctx.jobId),
        eq(approvalRequests.toolName, toolName),
        eq(approvalRequests.kind, 'approval'),
        eq(approvalRequests.status, 'rejected'),
      ),
    );
  const action = actionOf(input, purposeIsArgument);
  const same = rows.find((r) => actionOf(r.toolInput, purposeIsArgument) === action);
  return same ? { approvalRequestId: same.id, notes: same.notes } : null;
}

/**
 * Ce que le modèle reçoit à la place d'une seconde carte. Texte pour le
 * MODÈLE, jamais pour l'écran : le fait, la décision citée, le geste permis.
 */
export function alreadyRejectedInstruction(toolName: string, prior: PriorRejection): string {
  const reason = prior.notes && prior.notes.trim() !== '' ? prior.notes.trim() : 'none given';
  return (
    `approval_already_rejected: the owner already rejected this exact "${toolName}" call in ` +
    `this run (approval ${prior.approvalRequestId}, reason: ${reason}). Rewording \`purpose\` ` +
    `does not change the call, so it was NOT submitted again. Do not repeat it. Report the ` +
    `refusal in your result, or do something different.`
  );
}
