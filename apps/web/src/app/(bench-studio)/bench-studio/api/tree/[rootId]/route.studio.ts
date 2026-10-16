// GET /bench-studio/api/tree/<rootJobId> — l'arbre des jobs d'un essai, lu dans la base de la stack.
import { studioError, studioRouteRefusal, studioRuntime } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ rootId: string }> },
): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  try {
    return Response.json(await studioRuntime().jobTree((await params).rootId));
  } catch (e) {
    return studioError(e, 500);
  }
}
