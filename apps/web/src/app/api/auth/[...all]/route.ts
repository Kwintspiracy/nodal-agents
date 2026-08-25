/**
 * better-auth catch-all route.
 *
 * Handles all /api/auth/* requests (sign-up, sign-in, session, sign-out, …)
 * by delegating to the better-auth instance configured in local-auth mode.
 *
 * This route is only reachable when AUTH_MODE=local-auth. In local-trust mode
 * no one navigates to /login so it is never called. The handler is resolved
 * lazily on first request so build-time page-data collection does not throw.
 */

import { toNextJsHandler } from '@nodal-agents/auth';
import { getBetterAuth } from '@/lib/server.ts';

// Lazily resolved on first request — prevents build-time initialization when
// AUTH_MODE is absent (Next.js static build has no env vars set).
let _handler: ReturnType<typeof toNextJsHandler> | null = null;

function getHandler(): ReturnType<typeof toNextJsHandler> {
  if (!_handler) {
    _handler = toNextJsHandler(getBetterAuth().handler);
  }
  return _handler;
}

/**
 * Donne au limiteur de débit une clé STABLE (revue P1 du 25/08, finding
 * bloquant). better-auth dérive sa clé d'une IP qu'il ne lit que dans
 * `x-forwarded-for` ; sans reverse-proxy — le cas normal d'un Nodal sur le
 * LAN — il n'en trouve aucune et **désactive silencieusement tout plafond**
 * (`if (!ip) return null`, dist/api/rate-limiter). Résultat : /sign-in sans
 * aucune limite sur le seul compte de l'install.
 *
 * On écrase donc l'en-tête plutôt que de le lire : Nodal n'est pas derrière un
 * proxy de confiance, un `x-forwarded-for` venant du client ne prouve rien et
 * permettrait au contraire de contourner le plafond en le faisant varier. La
 * clé devient globale à l'install — acceptable ici (un utilisateur légitime,
 * de l'ordre de 1) et infiniment préférable à l'absence de plafond.
 */
function withStableRateLimitKey(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set('x-forwarded-for', '127.0.0.1');
  return new Request(req, { headers });
}

export async function GET(req: Request): Promise<Response> {
  return getHandler().GET(withStableRateLimitKey(req));
}

export async function POST(req: Request): Promise<Response> {
  return getHandler().POST(withStableRateLimitKey(req));
}
