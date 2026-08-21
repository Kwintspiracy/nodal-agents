/**
 * Next.js 16 proxy (NOT middleware.ts — that name is deprecated).
 *
 * Responsibilities:
 *  1. In local-trust mode (AUTH_MODE=local-trust, default): pass all requests
 *     through — no auth check needed, the server trusts any local request.
 *  2. In local-auth / bearer-token modes: gate /(dashboard)/* routes and
 *     redirect to /login if no session cookie is present.
 *
 * Note: Server Actions (POST with Next-Action header) are exempt from redirect
 * logic — they handle auth failures via requireAuth() inside the action.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { isAllowedHost } from '@nodal-agents/auth';

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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const authMode = process.env['AUTH_MODE'] ?? 'local-trust';

  // ── Host admission control (NETWORK-001, audit 2026-08-07) ─────────────────
  //
  // Next's own server-action guard compares `Origin` against `Host`, and only
  // consults `serverActions.allowedOrigins` when the two DIFFER. Measured on a
  // real packed install:
  //
  //   Origin: http://evil.test  +  Host: 127.0.0.1:3210  → 500  (allowlist wins)
  //   Origin: http://evil.test  +  Host: evil.test       → 200  (short-circuit)
  //
  // The second pair is exactly what a browser sends during DNS rebinding, where
  // the attacker points their own hostname at 127.0.0.1. Origin and Host agree,
  // the equality check passes, and the allowlist is never reached — so
  // `allowedOrigins` alone CANNOT close this. Validating `Host` here, before any
  // handler runs, is what does: `evil.test` is not a name that can mean this
  // machine.
  //
  // Runs before the auth branch on purpose. This is not about WHO is calling —
  // no credential fixes a forged Host — and it must hold in local-trust, which
  // is the default a normal install gets.
  const host = request.headers.get('host');
  if (!isAllowedHost(host, process.env['NEXT_PUBLIC_APP_URL'])) {
    // Invariant 2: a machine-readable code, no user-facing prose.
    return new NextResponse(JSON.stringify({ error: 'host_not_allowed' }), {
      status: 403,
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

  if (isPublicPath(pathname)) {
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

export const config = {
  matcher: [
    // Gate all routes except Next.js internals and static assets.
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|map)$).*)',
  ],
};
