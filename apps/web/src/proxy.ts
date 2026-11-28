/**
 * Next.js 16 proxy (NOT middleware.ts — that name is deprecated).
 *
 * It runs on EVERY request: no `config.matcher` is exported, so no path is
 * skipped because of what its name looks like — a page, a route handler, a
 * server action, a static file alike.
 *
 * Responsibilities, in this order:
 *  1. In the mode with no password (AUTH_MODE=local-trust, default): a launch
 *     link (`?nodal_launch=`, packages/auth/src/lib/launch-link.ts) is
 *     exchanged, once, for the dashboard cookie, and the address bar is
 *     cleaned by a redirect.
 *  2. Admission, in every auth mode: the one decision both servers share
 *     (`admitRequest`, packages/auth/src/lib/request-origin.ts). The Host
 *     names this machine; a request sent on behalf of a page (it carries an
 *     `Origin`) comes from a page this dashboard serves itself, or carries the
 *     install's secret; in the mode with no password, EVERY request proves who
 *     sends it: the browser by the dashboard cookie, a program (the CLI's
 *     probes, the e2e helpers) by the install's secret in an explicit header;
 *     a body has the media type its route takes. The cookie is never what
 *     lets a page in: the Origin rule does not count it.
 *  3. A browser without that proof gets the page that says how to get the
 *     link again (lib/launch-page.ts), on every path: never a blank error.
 *  4. In local-auth / bearer-token modes, whose proof is the sign-in: send a
 *     page request with no session cookie to /login. This is a convenience,
 *     not a guard: the dashboard layout and every action validate the session
 *     themselves.
 */

import { type NextRequest, NextResponse } from 'next/server';
import {
  DASHBOARD_COOKIE_MAX_AGE_S,
  LAUNCH_PARAM,
  LaunchLedger,
  admitRequest,
  bodyTypesFor,
  constantTimeEqual,
  dashboardCookieName,
  hasRequestBody,
  mintDashboardCookie,
  verifyDashboardCookie,
  verifyLaunchToken,
  type AdmissionRefusal,
  type BodyRoute,
  type RequestProof,
} from '@nodal-agents/auth';
import { launchPageHtml, type LaunchPageReason } from './lib/launch-page';

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

// One ledger of used launch links for the dashboard process's whole life, kept
// on globalThis so that `next dev` re-evaluating this module does not forget
// the links already used.
const LEDGER_KEY = Symbol.for('nodal.dashboard.launch-ledger');
function ledger(): LaunchLedger {
  const store = globalThis as unknown as Record<symbol, LaunchLedger | undefined>;
  return (store[LEDGER_KEY] ??= new LaunchLedger());
}

/** The proof the request carries, verified, and whether it presented one at all. */
function proofOf(
  request: NextRequest,
  secret: string,
): { proof: RequestProof | null; presented: boolean } {
  let presented = false;
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== '') {
    presented = true;
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (secret !== '' && bearer !== '' && constantTimeEqual(bearer, secret)) {
      return { proof: 'worker_secret', presented };
    }
  }
  if (secret !== '') {
    const cookie = request.cookies.get(dashboardCookieName(secret))?.value;
    if (cookie !== undefined) {
      presented = true;
      if (verifyDashboardCookie(secret, cookie, Date.now()) === null) {
        return { proof: 'launch_cookie', presented };
      }
    }
  }
  return { proof: null, presented };
}

/** Invariant 2: a machine-readable code, no user-facing prose. */
function refusalJson(
  refusal: AdmissionRefusal | { status: 500; reason: 'install_secret_missing' },
): NextResponse {
  return new NextResponse(JSON.stringify({ error: refusal.reason }), {
    status: refusal.status,
    headers: { 'content-type': 'application/json' },
  }) as NextResponse;
}

/** The page that says how to get the link again, with its reason. */
function launchPage(request: NextRequest, reason: LaunchPageReason): NextResponse {
  // A navigation from another site carries no `SameSite=Strict` cookie: the
  // page asks the browser to open the address once more from here.
  const retryFromHere =
    reason === 'proof_required' &&
    request.method === 'GET' &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-site') === 'cross-site';
  return new NextResponse(launchPageHtml({ reason, retryFromHere }), {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-nodal-refusal': reason,
    },
  }) as NextResponse;
}

/** The same address without the launch parameter. */
function cleanAddress(request: NextRequest): URL {
  const clean = request.nextUrl.clone();
  clean.searchParams.delete(LAUNCH_PARAM);
  return clean;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const authMode = process.env['AUTH_MODE'] ?? 'local-trust';
  // The modes with a sign-in prove the browser by its session; the mode with
  // no password proves it here.
  const noPassword = authMode === 'local-trust';
  const secret = process.env['WORKER_SECRET'] ?? '';
  if (noPassword && secret === '') {
    // Invariant 4: no browser can be let in without the install's secret.
    return refusalJson({ status: 500, reason: 'install_secret_missing' });
  }

  const facts = {
    origin: request.headers.get('origin'),
    host: request.headers.get('host'),
    appUrl: process.env['NEXT_PUBLIC_APP_URL'],
    servesPages: true,
    contentType: request.headers.get('content-type'),
    hasBody: hasRequestBody(request.headers),
    bodyTypes: bodyTypesOf(request.method, pathname),
  };

  // ── The launch link ───────────────────────────────────────────────────────
  //
  // Exchanged once for the cookie, then the browser is sent to the same
  // address without it. The Host rule still runs first: a link is no proof
  // for a name that does not mean this machine. The link itself is the proof
  // of this one request.
  const launch =
    noPassword && request.method === 'GET' ? request.nextUrl.searchParams.get(LAUNCH_PARAM) : null;
  if (launch !== null) {
    const refusal = admitRequest({
      ...facts,
      proof: null,
      proofPresented: true,
      proofRequired: false,
    });
    if (refusal) return refusalJson(refusal);
    const now = Date.now();
    const verdict = verifyLaunchToken(secret, launch, now);
    if (!verdict.ok) return launchPage(request, verdict.reason);
    if (!ledger().consume(verdict.nonce, verdict.expiresAt, now)) {
      return launchPage(request, 'launch_used');
    }
    // Next relativizes the address to the browser's own Host.
    const res = NextResponse.redirect(cleanAddress(request), 303);
    res.headers.set('cache-control', 'no-store');
    res.headers.set('referrer-policy', 'no-referrer');
    res.cookies.set(dashboardCookieName(secret), mintDashboardCookie(secret, now), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: DASHBOARD_COOKIE_MAX_AGE_S,
      secure: request.nextUrl.protocol === 'https:',
    });
    return res;
  }

  // ── Admission ─────────────────────────────────────────────────────────────
  //
  // Runs before the auth branch on purpose, and in every mode: no credential
  // fixes a forged Host, and a foreign page is refused whoever is signed in. A
  // cookie is never a proof against a page: the browser attaches it on its
  // own, to a foreign page's request too.
  const { proof, presented } = proofOf(request, secret);
  const refusal = admitRequest({
    ...facts,
    proof,
    proofPresented: presented,
    proofRequired: noPassword,
  });
  if (refusal) {
    if (refusal.reason === 'proof_required' || refusal.reason === 'proof_invalid') {
      return launchPage(request, refusal.reason);
    }
    return refusalJson(refusal);
  }

  // In the mode with no password, the browser has proved who it is: pass.
  if (noPassword) {
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
