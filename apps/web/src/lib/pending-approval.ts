// pending-approval.ts — ce que la cloche et la pastille du rail savent d'une
// attente, et UNE façon de le tirer d'une ligne `approval_requests` : le
// layout (premier rendu) et le provider (relecture) le faisaient chacun de
// son côté, et un champ ajouté à l'un manquait à l'autre.

import type { ApprovalRow } from './actions.ts';

export type PendingApproval = Pick<
  ApprovalRow,
  | 'id'
  | 'jobId'
  | 'toolName'
  | 'agentName'
  | 'toolInput'
  | 'requestedAt'
  | 'jobChannel'
  | 'conversationChannel'
  // #465 — une question ne se répond pas depuis la cloche : elle y renvoie
  // vers le fil ou le run qui la porte.
  | 'kind'
  | 'conversationId'
>;

export function toPendingApproval(r: ApprovalRow): PendingApproval {
  return {
    id: r.id,
    jobId: r.jobId,
    toolName: r.toolName,
    agentName: r.agentName,
    toolInput: r.toolInput,
    requestedAt: r.requestedAt,
    // D'OÙ vient la demande. Le menu Chat range chaque attente dans son
    // dossier avec ces deux champs (#135, #148) — le canal de sa conversation
    // d'abord, celui de son job quand elle n'en a pas.
    jobChannel: r.jobChannel,
    conversationChannel: r.conversationChannel,
    kind: r.kind,
    conversationId: r.conversationId,
  };
}
