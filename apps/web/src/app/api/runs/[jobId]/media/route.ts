// GET /api/runs/<jobId>/media?path=<chemin affiché>&n=<rang>[&download=1]
//
// L'image, la piste audio ou la vidéo qu'un travail a livrée, pour l'encart de
// livraison (#490) : il la montre, la joue, et propose de la télécharger.
//
// Une ROUTE et pas une action serveur : une action rend une valeur, elle ne
// sert pas un fichier que `<audio>` et `<video>` lisent par morceaux.
//
// Ce qui est servi, et pourquoi rien d'autre, est dit dans
// `lib/delivered-media.ts` : un fichier que CE travail a écrit, sous les
// dossiers de l'entité, d'un type de la liste fermée. Ici : la session,
// l'appartenance du travail, et le protocole — `Range`, pour que la lecture
// avance et recule dans une piste sans tout recharger.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { loadRunAuditRows } from '@/lib/run-audit-rows.ts';
import { entityWorkspaceRoots } from '@/lib/workspace-roots.ts';
import { resolveDeliveredMedia, type DeliveredMediaRefusal } from '@/lib/delivered-media.ts';
import { parseRange } from '@/lib/http-range.ts';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  path: z.string().min(1).max(4096),
  n: z.coerce.number().int().min(0).max(10_000),
  download: z.literal('1').optional(),
});

/** Le code HTTP de chaque refus : un fichier parti depuis n'est pas une requête fausse. */
const REFUSAL_STATUS: Readonly<Record<DeliveredMediaRefusal, number>> = {
  not_delivered: 404,
  gone: 404,
  not_media: 415,
  ambiguous: 409,
  outside: 403,
};

function refuse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    // `nosniff` sur les refus aussi, comme sur les fichiers servis (revue de la PR #493).
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** `filename*` en UTF-8 (RFC 6266), et un repli ASCII pour les vieux clients. */
function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  let session: { entityId: string };
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return refuse('unauthorized', 401);
  }

  const { jobId } = await params;
  if (!z.string().guid().safeParse(jobId).success) return refuse('validation_failed', 400);
  const url = new URL(req.url);
  const query = QuerySchema.safeParse({
    path: url.searchParams.get('path') ?? undefined,
    n: url.searchParams.get('n') ?? undefined,
    download: url.searchParams.get('download') ?? undefined,
  });
  if (!query.success) return refuse('validation_failed', 400);

  const db = getDb();
  // Une base en panne se dit, comme dans `getRunFileChangesAction`, au lieu
  // d'un 500 brut (revue de la PR #493).
  let audit: Awaited<ReturnType<typeof loadRunAuditRows>>;
  let roots: string[];
  try {
    audit = await loadRunAuditRows(db, session.entityId, jobId);
    roots = audit === null ? [] : await entityWorkspaceRoots(db, session.entityId);
  } catch (err) {
    console.error('[GET /api/runs/media]', err);
    return refuse('db_error', 500);
  }
  if (audit === null) return refuse('job_not_found', 404);
  const found = await resolveDeliveredMedia(audit, roots, query.data.path, query.data.n);
  if (!found.ok) return refuse(found.code, REFUSAL_STATUS[found.code]);
  const media = found.media;

  const headers: Record<string, string> = {
    'Content-Type': media.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(
      query.data.download === '1' ? 'attachment' : 'inline',
      media.fileName,
    ),
  };

  const range = parseRange(req.headers.get('range'), media.size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${media.size}` },
    });
  }
  // La taille vient du `stat` du résolveur : un fichier raccourci entre ce
  // `stat` et la lecture rend un corps plus court que `Content-Length`, et le
  // navigateur voit une réponse interrompue. Sans verrou, aucun serveur de
  // fichiers n'y échappe ; un média livré ne change plus (revue de la PR #493).
  const start = range?.start ?? 0;
  const end = range?.end ?? media.size - 1;
  const body =
    media.size === 0
      ? null
      : (Readable.toWeb(createReadStream(media.absPath, { start, end })) as ReadableStream);
  return new Response(body, {
    status: range === null ? 200 : 206,
    headers: {
      ...headers,
      'Content-Length': String(media.size === 0 ? 0 : end - start + 1),
      ...(range !== null ? { 'Content-Range': `bytes ${start}-${end}/${media.size}` } : {}),
    },
  });
}
