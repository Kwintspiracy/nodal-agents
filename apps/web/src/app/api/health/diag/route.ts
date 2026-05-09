// TEMPORARY DIAGNOSTIC ROUTE — used to debug a LAN auth issue from a mobile
// phone. Hit from the same browser tab that just attempted a sign-in: the JSON
// reveals what cookies the browser is sending back to the server, plus the
// Origin / Sec-Fetch headers it emits. Delete once the LAN sign-in bug is
// understood and fixed.
//
// Mounted under /api/health so it's already whitelisted by proxy.ts.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieNames = cookieHeader
    .split(';')
    .map((c) => c.trim().split('=')[0])
    .filter(Boolean);
  const url = new URL(req.url);
  return NextResponse.json({
    hostHeader: req.headers.get('host'),
    parsedUrlHost: url.host,
    parsedUrlProto: url.protocol,
    pathname: url.pathname,
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    cookieHeader: cookieHeader || '(empty)',
    hasSessionCookie: cookieHeader.includes('better-auth.session_token'),
    cookieNames,
    userAgent: req.headers.get('user-agent'),
    secFetchSite: req.headers.get('sec-fetch-site'),
    secFetchMode: req.headers.get('sec-fetch-mode'),
    secFetchDest: req.headers.get('sec-fetch-dest'),
  });
}
