// login/page.tsx — Server Component that reads the runtime AUTH_MODE
//
// CRITICAL: this MUST be a Server Component (no 'use client').
//   - NEXT_PUBLIC_* env vars are inlined at BUILD time, so they don't reflect
//     the user's choice at install time. Server Components read process.env at
//     REQUEST time, which is what we need for a runtime-configurable install.
//   - Force dynamic so the server reads env on every request.
//
// In local-auth mode the page also resolves the install's setup state so the
// form can render the ONE flow that can actually succeed:
//   fresh → first-user sign-up; claim → owner-account claim (install migrated
//   from local-trust: user exists, no password); ready → sign-in.

import LocalTrustBanner from './LocalTrustBanner.tsx';
import AuthLoginForm from './AuthLoginForm.tsx';
import { env } from '@/lib/env.ts';
import { getAuthProvider } from '@/lib/server.ts';
import { LocalAuthProvider, type AuthSetupState } from '@nodal-agents/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (env.AUTH_MODE === 'local-trust') {
    return <LocalTrustBanner />;
  }
  const provider = getAuthProvider();
  const setup: AuthSetupState =
    provider instanceof LocalAuthProvider ? await provider.getSetupState() : 'ready';
  const openSignup = process.env['NODALAI_ALLOW_OPEN_SIGNUP'] === '1';
  return <AuthLoginForm setup={setup} openSignup={openSignup} />;
}
