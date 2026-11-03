// DELETE /api/voice/turns/:turnId — annuler un tour dit (#942) : le bouton
// relâché après avoir glissé hors de lui. Relais pur, voir `../route.ts`.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const { turnId } = await params;
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/turns/${encodeURIComponent(turnId)}`, {
    method: 'DELETE',
    door: 'voice/turns/cancel',
  });
}
