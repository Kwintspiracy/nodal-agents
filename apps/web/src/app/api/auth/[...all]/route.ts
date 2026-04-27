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

import { toNextJsHandler } from '@nodalai/auth';
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

export async function GET(req: Request): Promise<Response> {
  return getHandler().GET(req);
}

export async function POST(req: Request): Promise<Response> {
  return getHandler().POST(req);
}
