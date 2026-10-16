// POST /bench-studio/api/plan — le plan d'une sélection (et son coût quand des modèles sont nommés).
import { studioPlan, type PlanRequest } from '@nodal-agents/bench/studio';
import { studioError, studioRouteRefusal } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  try {
    return Response.json(studioPlan((await req.json()) as PlanRequest));
  } catch (e) {
    return studioError(e);
  }
}
