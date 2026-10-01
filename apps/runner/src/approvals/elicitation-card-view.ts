// approvals/elicitation-card-view.ts — la carte d'une question de serveur MCP
// (0145) telle qu'un canal à boutons la montre, LUE DE LA LIGNE : sa question,
// son formulaire, son brouillon (0146), rendue selon ce que le canal déclare
// pouvoir porter. Une seule lecture et un seul rendu pour l'envoi
// (notify.ts) et pour chaque geste (elicitation-channel.ts) : une carte
// réécrite ne peut pas dire autre chose que la carte envoyée.

import {
  eq,
  approvalRequests,
  approvalRequestAttachments,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  readElicitationToolInput,
  parseElicitationSchema,
  readElicitationDraft,
  initialElicitationDraft,
  renderElicitationCard,
  type ElicitationDraft,
  type ElicitationField,
  type ElicitationToolInput,
  type RenderedElicitationCard,
} from '@nodal-agents/shared';
import { getAdapter, type ChannelKind } from '@nodal-agents/delivery';

/** Une élicitation lue de sa ligne, prête à être rendue. */
export interface ElicitationCardState {
  approvalRequestId: string;
  jobId: string;
  status: string | null;
  asked: ElicitationToolInput;
  fields: ElicitationField[];
  draft: ElicitationDraft;
  imageCount: number;
}

export type LoadedElicitation =
  | { ok: true; state: ElicitationCardState }
  | { ok: false; reason: 'not_found' | 'not_an_elicitation' | 'unreadable' };

/**
 * La ligne, lue et vérifiée : une élicitation dont la question ou le
 * formulaire ne se lisent plus n'a pas de carte (le dashboard la montre
 * brute), et son brouillon absent part des défauts du serveur.
 */
export async function loadElicitationCard(
  db: AnyDrizzleDb,
  approvalRequestId: string,
): Promise<LoadedElicitation> {
  const [row] = await db
    .select({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
      kind: approvalRequests.kind,
      status: approvalRequests.status,
      toolInput: approvalRequests.toolInput,
      draft: approvalRequests.draft,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.kind !== 'elicitation') return { ok: false, reason: 'not_an_elicitation' };
  const asked = readElicitationToolInput(row.toolInput);
  const form = asked ? parseElicitationSchema(asked.requestedSchema) : null;
  if (!asked || !form?.ok) return { ok: false, reason: 'unreadable' };
  const images = await db
    .select({ id: approvalRequestAttachments.id })
    .from(approvalRequestAttachments)
    .where(eq(approvalRequestAttachments.approvalRequestId, approvalRequestId));
  return {
    ok: true,
    state: {
      approvalRequestId: row.id,
      jobId: row.jobId,
      status: row.status,
      asked,
      fields: form.fields,
      draft: readElicitationDraft(row.draft) ?? initialElicitationDraft(form.fields),
      imageCount: images.length,
    },
  };
}

/** La carte de cet état, rendue dans les limites que ce canal déclare. */
export function renderElicitationCardFor(
  state: ElicitationCardState,
  channel: ChannelKind,
  draft: ElicitationDraft = state.draft,
): RenderedElicitationCard {
  const limits = getAdapter(channel).capabilities.buttonLimits;
  return renderElicitationCard({
    approvalRequestId: state.approvalRequestId,
    server: state.asked.server,
    message: state.asked.message,
    fields: state.fields,
    draft,
    imageCount: state.imageCount,
    ...(limits ? { limits } : {}),
  });
}
