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
  // Rebuilt from url + init, NEVER `new Request(req, { headers })`. The
  // copy-constructor reads the incoming request's private state through a
  // brand check, and under Turbopack the request Next.js hands us comes from
  // a different `Request` realm than this module's — the check throws
  // (`Cannot read private member #state`) and EVERY /api/auth/* call 500s,
  // i.e. nobody can sign in. Shipped that way in PR #38 and only noticed on
  // 29/08, because no test ever called the route with a request of another
  // class. The e2e sign-in and auth-route.test.ts now do.
  //
  // `duplex: 'half'` is what Node's Request requires whenever a body stream
  // is passed; it is harmless for GET (no body).
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    // @ts-expect-error -- `duplex` is required by Node's undici when a body stream is present; not in lib.dom's RequestInit yet.
    duplex: 'half',
  });
}

export async function GET(req: Request): Promise<Response> {
  return getHandler().GET(withStableRateLimitKey(req));
}

export async function POST(req: Request): Promise<Response> {
  return getHandler().POST(withStableRateLimitKey(req));
}
