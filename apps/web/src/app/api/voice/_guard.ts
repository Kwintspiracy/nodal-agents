import 'server-only';
import { checkRequestOrigin, requireAuth } from '@nodal-agents/auth';
import { getAuthProvider, applyActiveEntity } from '@/lib/server.ts';

/**
 * Admission control for the voice routes.
 *
 * These are ROUTE HANDLERS, not server actions, because audio is binary and a
 * server action serialises through the RSC wire. That choice costs a guard:
 * Next validates `Origin` against `Host` for every server action by itself, and
 * does nothing of the sort for `/api/*`. `proxy.ts` covers the Host half for
 * every route (NETWORK-001), so without the lines below any page on the web
 * could POST here from a browser that is already logged in, and:
 *
 *   - burn the install's Gemini quota one synthesis at a time, and
 *   - use the transcription route as a free speech-to-text service billed to
 *     someone else's key.
 *
 * CORS would stop the attacker READING the answer. It does not stop the request
 * from executing, and neither of those two abuses needs the answer.
 *
 * Auth is checked as well, and in this order: origin first, because no
 * credential makes a forged origin acceptable, and because the cheap check
 * should run before the database is touched.
 */
export type VoiceGuardFailure = { response: Response };

export async function guardVoiceRequest(
  req: Request,
): Promise<{ userId: string; entityId: string } | VoiceGuardFailure> {
  const rejection = checkRequestOrigin({
    origin: req.headers.get('origin'),
    host: req.headers.get('host'),
    appUrl: process.env['NEXT_PUBLIC_APP_URL'],
  });
  if (rejection) {
    // A machine-readable code, no prose (invariant #2).
    return {
      response: Response.json({ error: rejection }, { status: 403 }),
    };
  }

  try {
    // applyActiveEntity, not the raw session: a user with several workspaces
    // has one ACTIVE one, carried by a cookie. Skipping it would resolve the
    // voice and the LLM key of whichever workspace the session defaults to —
    // an agent answering in another workspace's voice, billed to another
    // workspace's key.
    const session = await applyActiveEntity(await requireAuth(req, getAuthProvider()), req);
    return { userId: session.userId, entityId: session.entityId };
  } catch {
    return { response: Response.json({ error: 'unauthenticated' }, { status: 401 }) };
  }
}

export function isGuardFailure(
  r: { userId: string; entityId: string } | VoiceGuardFailure,
): r is VoiceGuardFailure {
  return 'response' in r;
}
