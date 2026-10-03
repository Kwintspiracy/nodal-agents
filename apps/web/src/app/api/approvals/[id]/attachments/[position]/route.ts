// GET /api/approvals/<id>/attachments/<position>
//
// Une image qu'un serveur MCP a jointe à sa question (élicitation, migration
// 0145 : `approval_request_attachments`), pour les vignettes de la carte.
//
// Une ROUTE et pas une action : `<img>` lit une adresse, il ne reçoit pas une
// valeur. Et jamais une `data:` dans la page : une question peut porter
// plusieurs Mo d'images, et le fil se relit toutes les quelques secondes.
//
// Ce qui est servi : la pièce d'une demande de l'ENTITÉ de la session, rien
// d'autre — même réponse pour « n'existe pas » et « appartient à un autre
// espace ». Le type vient de la ligne, que la base borne aux images
// (`approval_request_attachments_mime_check`), et `nosniff` empêche le
// navigateur d'en deviner un autre.

import { z } from 'zod';
import { and, eq, approvalRequests, approvalRequestAttachments } from '@nodal-agents/db';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';

export const dynamic = 'force-dynamic';

function refuse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; position: string }> },
): Promise<Response> {
  let session: { entityId: string };
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return refuse('unauthorized', 401);
  }

  const { id, position } = await params;
  if (!z.string().guid().safeParse(id).success) return refuse('validation_failed', 400);
  const pos = z.coerce.number().int().min(0).max(1000).safeParse(position);
  if (!pos.success) return refuse('validation_failed', 400);

  let row: { mimeType: string; data: string } | undefined;
  try {
    [row] = await getDb()
      .select({
        mimeType: approvalRequestAttachments.mimeType,
        data: approvalRequestAttachments.data,
      })
      .from(approvalRequestAttachments)
      .innerJoin(
        approvalRequests,
        eq(approvalRequests.id, approvalRequestAttachments.approvalRequestId),
      )
      .where(
        and(
          eq(approvalRequestAttachments.approvalRequestId, id),
          eq(approvalRequestAttachments.position, pos.data),
          eq(approvalRequests.entityId, session.entityId),
        ),
      )
      .limit(1);
  } catch (err) {
    console.error('[GET /api/approvals/attachments]', err);
    return refuse('db_error', 500);
  }
  if (!row) return refuse('not_found', 404);

  const bytes = Buffer.from(row.data, 'base64');
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': row.mimeType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': 'inline',
    },
  });
}
