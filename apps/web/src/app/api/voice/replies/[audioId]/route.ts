// GET /api/voice/replies/:audioId — la voix de la réponse d'un job lancé par la
// voix (#967), depuis le navigateur. La porte web de la route du runner
// (apps/runner/src/routes/voice-reply.ts, dont l'en-tête décrit le protocole).
// Un relais, rien de plus (règle du #948) : un module externe lit la même
// route. La seule chose que la porte écrit elle-même est l'ENTITÉ, prise sur
// la session.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ audioId: string }> },
): Promise<Response> {
  const { audioId } = await params;
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/replies/${encodeURIComponent(audioId)}`, {
    method: 'GET',
    door: 'voice/replies',
    query: (session) => ({ entityId: session.entityId }),
  });
}
