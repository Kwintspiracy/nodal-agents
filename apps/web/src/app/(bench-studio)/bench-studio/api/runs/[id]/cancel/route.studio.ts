// POST /bench-studio/api/runs/<id>/cancel — plus aucun essai ne part, les essais vivants sont annulés.
import { studioError, studioRouteRefusal, studioRuntime } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  try {
    await studioRuntime().manager.cancel((await params).id);
    return Response.json({ ok: true });
  } catch (e) {
    return studioError(e);
  }
}
