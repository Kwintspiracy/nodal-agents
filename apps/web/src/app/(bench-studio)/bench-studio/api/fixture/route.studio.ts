// GET /bench-studio/api/fixture?path=… — le fichier brut d'une fixture, à télécharger.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { FIXTURES_DIR, readFixture } from '@nodal-agents/bench/studio';
import { studioError, studioRouteRefusal } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  const path = new URL(req.url).searchParams.get('path') ?? '';
  try {
    // readFixture refuse tout chemin hors du dossier des fixtures.
    readFixture(path);
    return new Response(readFileSync(resolve(FIXTURES_DIR, path)), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${basename(path)}"`,
      },
    });
  } catch (e) {
    return studioError(e, 404);
  }
}
