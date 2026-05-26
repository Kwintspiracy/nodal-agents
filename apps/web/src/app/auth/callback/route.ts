import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// OAuth callback handler — placeholder for Brique 16b.
// In local-auth mode, better-auth handles its own callbacks at /api/auth/*.
// This route exists to catch OAuth redirects that target /auth/callback.
export function GET(request: NextRequest): NextResponse {
  // Land on Home after successful OAuth (real handling in 16b).
  return NextResponse.redirect(new URL('/', request.url));
}
