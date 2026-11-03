// POST /api/voice/turns/:turnId/chunks/:seq — un morceau d'audio, envoyé
// PENDANT que le bouton est tenu (#942). Le corps passe en flux, sans être lu
// ici : le rang et la borne de taille sont tenus par le runner. Relais pur,
// voir `../../../route.ts`.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ turnId: string; seq: string }> },
): Promise<Response> {
  const { turnId, seq } = await params;
  return proxyToRunner(
    req,
    `${env.RUNNER_URL}/api/voice/turns/${encodeURIComponent(turnId)}/chunks/${encodeURIComponent(seq)}`,
    { method: 'POST', door: 'voice/turns/chunk' },
  );
}
