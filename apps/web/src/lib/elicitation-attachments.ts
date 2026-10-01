// elicitation-attachments.ts — CE QUE l'écran sait des images jointes à des
// élicitations : leur rang, leur type, leur légende. Jamais leurs octets — la
// route `/api/approvals/<id>/attachments/<n>` les sert, une par une, à qui a le
// droit de les voir.
//
// UNE lecture pour les deux endroits qui dessinent la carte (la page Approvals
// et le fil), et une requête pour toute la page, jamais une par demande.

import 'server-only';
import { inArray, approvalRequestAttachments } from '@nodal-agents/db';
import type { ElicitationAttachmentView } from './elicitation-view.ts';
import type { getDb } from './server.ts';

// Le type de la base, dérivé de `getDb` comme dans job-feed.ts — jamais importé
// de job-feed.ts, qui lit ce module (dépendance circulaire).
type Db = ReturnType<typeof getDb>;

/**
 * Les images de ces demandes, rangées par demande. Les ids viennent de lignes
 * déjà lues SOUS l'entité de la session : cette lecture ne refait pas le
 * filtre, elle ne peut rien ajouter que la page n'ait déjà.
 */
export async function readAttachmentViews(
  db: Db,
  approvalRequestIds: readonly string[],
): Promise<Map<string, ElicitationAttachmentView[]>> {
  const out = new Map<string, ElicitationAttachmentView[]>();
  if (approvalRequestIds.length === 0) return out;
  const rows = await db
    .select({
      approvalRequestId: approvalRequestAttachments.approvalRequestId,
      position: approvalRequestAttachments.position,
      mimeType: approvalRequestAttachments.mimeType,
      caption: approvalRequestAttachments.caption,
    })
    .from(approvalRequestAttachments)
    .where(inArray(approvalRequestAttachments.approvalRequestId, [...approvalRequestIds]))
    .orderBy(approvalRequestAttachments.position);
  for (const r of rows) {
    const list = out.get(r.approvalRequestId) ?? [];
    list.push({ position: r.position, mimeType: r.mimeType, caption: r.caption });
    out.set(r.approvalRequestId, list);
  }
  return out;
}
