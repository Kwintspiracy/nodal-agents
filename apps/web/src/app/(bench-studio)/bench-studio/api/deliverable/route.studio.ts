// GET /bench-studio/api/deliverable?path=… — un fichier laissé par un essai, à télécharger.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { studioError, studioRouteRefusal, studioRuntime } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  const path = new URL(req.url).searchParams.get('path') ?? '';
  try {
    const d = await studioRuntime().deliverable(path);
    const body = d.kind === 'text' ? d.text : readFileSync(d.abs);
    return new Response(body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${basename(path)}"`,
      },
    });
  } catch (e) {
    return studioError(e, 404);
  }
}
