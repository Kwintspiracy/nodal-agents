/**
 * Next.js 16 proxy (NOT middleware.ts — that name is deprecated).
 *
 * It runs on EVERY request: no `config.matcher` is exported, so no path is
 * skipped because of what its name looks like — a page, a route handler, a
 * server action, a static file alike.
 *
 * Responsibilities, in this order:
 *  1. Admission, in every auth mode: the one decision both servers share
 *     (`admitRequest`, packages/auth/src/lib/request-origin.ts). The Host
 *     names this machine; a request sent on behalf of a page (it carries an
 *     `Origin`) comes from a page this dashboard serves itself; a body has the
 *     media type its route takes.
 *  2. In local-trust mode (AUTH_MODE=local-trust, default): nothing more.
 *  3. In local-auth / bearer-token modes: send a page request with no session
 *     cookie to /login. This is a convenience, not a guard: the dashboard
 *     layout and every action validate the session themselves.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { admitRequest, bodyTypesFor, hasRequestBody, type BodyRoute } from '@nodal-agents/auth';

/** The dashboard's route handlers that take a body of another type than JSON. */
const DASHBOARD_BODY_ROUTES: readonly BodyRoute[] = [
  // The audio of a spoken turn, relayed to the runner as it came.
  {
    method: 'POST',
    path: '/api/voice/turns/:turnId/chunks/:seq',
    types: ['application/octet-stream'],
  },
  // The credential wizard's native form, which the browser posts itself to
  // start an OAuth flow (CredentialWizard.tsx).
  {
    method: 'POST',
    path: '/api/oauth/:provider/start',
    types: ['application/x-www-form-urlencoded'],
  },
];

/**
 * What a server action is posted as, on a page path: the encodings Next itself
 * sends (a fetch action, a form with or without JavaScript). These are all
 * types a page can send without a preflight: what proves a server action is
 * the Origin rule above, which only lets the dashboard's own pages in.
 */
const SERVER_ACTION_BODY: readonly string[] = [
  'text/plain',
  'multipart/form-data',
  'application/x-www-form-urlencoded',
];

/** The media types the request's path takes in a body. */
function bodyTypesOf(method: string, pathname: string): readonly string[] {
  return pathname.startsWith('/api/')
    ? bodyTypesFor(method, pathname, DASHBOARD_BODY_ROUTES)
    : SERVER_ACTION_BODY;
}

// Public paths that never require authentication.
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/api/auth/')
  );
}

/**
 * A read of a static file (an image, a font, a source map), which the login
 * redirect leaves alone so that the login page itself can show its images.
 * Used by that redirect ONLY: admission has already run on this request.
 */
function isStaticFileRead(method: string, pathname: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    /\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|map)$/.test(pathname)
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const authMode = process.env['AUTH_MODE'] ?? 'local-trust';

  // ── Admission ─────────────────────────────────────────────────────────────
  //
  // Runs before the auth branch on purpose, and in local-trust, which is the
  // default a normal install gets: no credential fixes a forged Host, and a
  // foreign page is refused whoever is signed in. A session cookie is never a
  // proof here: the browser attaches it on its own, to a foreign page's
  // request too.
  const refusal = admitRequest({
    origin: request.headers.get('origin'),
    host: request.headers.get('host'),
    appUrl: process.env['NEXT_PUBLIC_APP_URL'],
    proof: null,
    servesPages: true,
    contentType: request.headers.get('content-type'),
    hasBody: hasRequestBody(request.headers),
    bodyTypes: bodyTypesOf(request.method, pathname),
  });
  if (refusal) {
    // Invariant 2: a machine-readable code, no user-facing prose.
    return new NextResponse(JSON.stringify({ error: refusal.reason }), {
      status: refusal.status,
      headers: { 'content-type': 'application/json' },
    }) as NextResponse;
  }

  // In local-trust mode, pass everything through.
  if (authMode === 'local-trust') {
    return NextResponse.next({ request });
  }

  // Server Actions cannot handle HTTP redirects — skip redirect logic.
  if (request.headers.has('next-action')) {
    return NextResponse.next({ request });
  }

  if (isPublicPath(pathname) || isStaticFileRead(request.method, pathname)) {
    return NextResponse.next({ request });
  }

  // For local-auth mode: check for the better-auth session cookie.
  // The cookie name better-auth uses is 'better-auth.session_token'.
  const sessionCookie =
    request.cookies.get('better-auth.session_token') ?? request.cookies.get('nodalai.session');

  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next({ request });
}
