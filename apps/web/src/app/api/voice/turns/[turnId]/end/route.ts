// POST /api/voice/turns/:turnId/end — le bouton relâché : le runner transcrit,
// joue le tour et rend sa réponse dite (#942). Relais pur, voir `../../route.ts`.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const { turnId } = await params;
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/turns/${encodeURIComponent(turnId)}/end`, {
    method: 'POST',
    door: 'voice/turns/end',
  });
}
