// login/page.tsx — Server Component that reads the runtime AUTH_MODE
//
// CRITICAL: this MUST be a Server Component (no 'use client').
//   - NEXT_PUBLIC_* env vars are inlined at BUILD time, so they don't reflect
//     the user's choice at install time. Server Components read process.env at
//     REQUEST time, which is what we need for a runtime-configurable install.
//   - Force dynamic so the server reads env on every request.

import LocalTrustBanner from './LocalTrustBanner.tsx';
import AuthLoginForm from './AuthLoginForm.tsx';
import { env } from '@/lib/env.ts';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  if (env.AUTH_MODE === 'local-trust') {
    return <LocalTrustBanner />;
  }
  return <AuthLoginForm />;
}
