// POST /api/oauth/[provider]/start
// Initiates the OAuth authorization code flow: validates session + input,
// generates PKCE + CSRF state, signs a cookie, and redirects the browser
// to the provider's authorization URL.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { encrypt } from '@nodal-agents/secrets';
import { getAuthProvider, requireAuth } from '@/lib/server.ts';
import { getOAuthProvider, getProviderByCredentialType } from '@/lib/oauth-providers.ts';
import {
  generatePkce,
  generateState,
  signStatePayload,
  STATE_COOKIE_NAME,
} from '@/lib/oauth-state.ts';

const StartBodySchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  clientSecret: z.string().min(1, 'Client secret is required'),
  // name comes from a non-required HTML input; empty string → treat as absent.
  name: z
    .string()
    .max(120)
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
  // Optional URL to redirect to after the credential is created.
  // The callback will append ?credentialId={id} to this URL.
  returnTo: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: slug } = await params;

  // 1. Authenticate the caller
  let session: { userId: string; entityId: string };
  try {
    session = await requireAuth(req, getAuthProvider());
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Resolve provider — slug can be either a catalog connector slug (e.g. 'google-drive')
  // or a credentialType (e.g. 'google-oauth') when the wizard posts directly via type.
  const provider =
    getOAuthProvider(slug) ??
    getProviderByCredentialType(slug as import('@nodal-agents/shared').CredentialType);
  if (!provider) {
    return NextResponse.json({ error: `Unknown OAuth provider: ${slug}` }, { status: 400 });
  }

  // 3. Parse form-encoded body
  let rawBody: Record<string, string>;
  try {
    const text = await req.text();
    rawBody = Object.fromEntries(new URLSearchParams(text));
  } catch {
    return NextResponse.json({ error: 'Failed to parse request body' }, { status: 400 });
  }

  const parsed = StartBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { clientId, clientSecret, name, returnTo } = parsed.data;

  // 4. Encrypt clientSecret for storage in signed cookie
  const clientSecretEnc = encrypt(clientSecret);

  // 5. PKCE
  const { codeVerifier, codeChallenge } =
    provider.pkce === 'pkce-s256' ? generatePkce() : { codeVerifier: '', codeChallenge: '' };

  // 6. CSRF state
  const csrfState = generateState();

  // 7. Build + sign the state cookie payload
  const statePayload = {
    v: 1 as const,
    slug,
    entityId: session.entityId,
    state: csrfState,
    codeVerifier,
    clientId,
    clientSecretEnc,
    credentialType: provider.credentialType,
    ...(name !== undefined ? { name } : {}),
    ...(returnTo !== undefined ? { returnTo } : {}),
    createdAt: Date.now(),
  };
  const cookieValue = signStatePayload(statePayload);

  // 8. Cookie attributes
  const isHttps = new URL(req.url).protocol === 'https:';
  const cookieAttr = [
    `${STATE_COOKIE_NAME}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');

  // 9. Build the provider authorization URL
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/${slug}/callback`;

  const authParams = new URLSearchParams();
  authParams.set('client_id', clientId);
  authParams.set('redirect_uri', redirectUri);
  authParams.set('response_type', 'code');
  authParams.set('state', csrfState);

  if (provider.scopes.length > 0) {
    authParams.set('scope', provider.scopes.join(' '));
  }

  if (provider.pkce === 'pkce-s256') {
    authParams.set('code_challenge', codeChallenge);
    authParams.set('code_challenge_method', 'S256');
  }

  if (provider.authExtraParams) {
    for (const [k, v] of Object.entries(provider.authExtraParams)) {
      authParams.set(k, v);
    }
  }

  const authUrl = `${provider.authUrl}?${authParams.toString()}`;

  // 10. Redirect with cookie
  const response = NextResponse.redirect(authUrl, 302);
  response.headers.set('Set-Cookie', cookieAttr);
  return response;
}
