// POST /bench-studio/api/launch — lance une session du banc ; la porte est tenue par RunManager.
import type { LaunchRequest } from '@nodal-agents/bench/studio';
import { studioError, studioRouteRefusal, studioRuntime } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  try {
    const state = studioRuntime().manager.launch((await req.json()) as LaunchRequest);
    return Response.json({ id: state.id });
  } catch (e) {
    return studioError(e, 409);
  }
}
