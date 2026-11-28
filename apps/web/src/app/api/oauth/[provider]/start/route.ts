// POST /api/oauth/[provider]/start
// Initiates the OAuth authorization code flow FOR A CONNECTOR: validates
// session + input, generates PKCE + CSRF state, signs a cookie, and redirects
// the browser to the provider's authorization URL.
//
// `[provider]` is the credential type (`google-oauth`, `microsoft-oauth`, …):
// it names the OAuth client the person registered, so it is also the redirect
// URI they registered with the provider. The connector being connected comes
// in the body (`connector`), and the scopes asked for are that connector's
// provider entry, on top of what the credential already holds when the start
// adds access to an existing credential (`credentialId`). A start that names
// no connector is refused: there is no "first provider of the type" to fall
// back to, since that is how a Gmail card ended up asking for Drive.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { encrypt } from '@nodal-agents/secrets';
import { decryptCredentialForDisplay } from '@nodal-agents/db';
import { getAuthProvider, getDb, requireAuth } from '@/lib/server.ts';
import { getOAuthProvider } from '@/lib/oauth-providers.ts';
import {
  CREDENTIAL_TYPES,
  parseScopes,
  unionScopes,
  type CredentialType,
} from '@nodal-agents/shared';
import {
  generatePkce,
  generateState,
  signStatePayload,
  STATE_COOKIE_NAME,
} from '@/lib/oauth-state.ts';

/** An HTML input left empty arrives as '' — treat it as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v));

const StartBodySchema = z.object({
  connector: z
    .string({ error: 'connector is required: an authorisation is asked for one connector' })
    .min(1, 'connector is required: an authorisation is asked for one connector')
    .max(80),
  // Present when the start ADDS access to a credential the person already
  // has: its client id and secret are reused, its granted scopes are kept.
  credentialId: optionalText(64).pipe(z.string().guid('Invalid credential id').optional()),
  clientId: optionalText(500),
  clientSecret: optionalText(500),
  name: optionalText(120),
  // Optional URL to redirect to after the credential is created.
  // The callback will append ?credentialId={id} to this URL.
  returnTo: optionalText(500),
});

function isCredentialType(value: string): value is CredentialType {
  return (CREDENTIAL_TYPES as readonly string[]).includes(value);
}

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

  // 2. The path names the credential type (the OAuth client).
  if (!isCredentialType(slug)) {
    return NextResponse.json({ error: `Unknown OAuth provider: ${slug}` }, { status: 400 });
  }
  const credentialType = slug;

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

  const { connector, credentialId, name, returnTo } = parsed.data;

  // 4. The connector decides the scopes; it must authorise through this type.
  const provider = getOAuthProvider(connector);
  if (!provider || provider.credentialType !== credentialType) {
    return NextResponse.json(
      { error: `Connector '${connector}' does not authorise through '${credentialType}'` },
      { status: 400 },
    );
  }

  // 5. Adding access to an existing credential: reuse its client, keep its grant.
  let clientId: string;
  let clientSecret: string;
  let heldScopes: string[] = [];
  if (credentialId !== undefined) {
    const existing = await decryptCredentialForDisplay(getDb(), credentialId);
    if (!existing || existing.ownerUserId !== session.userId) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }
    if (existing.type !== credentialType) {
      return NextResponse.json(
        { error: `Credential type '${existing.type}' is not '${credentialType}'` },
        { status: 400 },
      );
    }
    clientId = existing.payload.clientId;
    clientSecret = existing.payload.clientSecret;
    heldScopes = parseScopes(existing.payload.scopes);
  } else {
    if (!parsed.data.clientId) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 });
    }
    if (!parsed.data.clientSecret) {
      return NextResponse.json({ error: 'Client secret is required' }, { status: 400 });
    }
    clientId = parsed.data.clientId;
    clientSecret = parsed.data.clientSecret;
  }

  // The union: the connector's scopes on top of what the grant already holds,
  // so the new token never covers less than the one it replaces (a provider
  // that merges grants itself, like Google with include_granted_scopes, gets
  // the same answer; one that does not still gets the full list).
  const requestedScopes = unionScopes(provider.scopes, heldScopes);

  // 6. Encrypt clientSecret for storage in signed cookie
  const clientSecretEnc = encrypt(clientSecret);

  // 7. PKCE
  const { codeVerifier, codeChallenge } =
    provider.pkce === 'pkce-s256' ? generatePkce() : { codeVerifier: '', codeChallenge: '' };

  // 8. CSRF state
  const csrfState = generateState();

  // 9. Build + sign the state cookie payload
  const statePayload = {
    v: 1 as const,
    slug,
    entityId: session.entityId,
    state: csrfState,
    codeVerifier,
    clientId,
    clientSecretEnc,
    credentialType,
    connector,
    requestedScopes: requestedScopes.join(' '),
    ...(credentialId !== undefined ? { credentialId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(returnTo !== undefined ? { returnTo } : {}),
    createdAt: Date.now(),
  };
  const cookieValue = signStatePayload(statePayload);

  // 10. Cookie attributes
  const isHttps = new URL(req.url).protocol === 'https:';
  const cookieAttr = [
    `${STATE_COOKIE_NAME}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600',
    ...(isHttps ? ['Secure'] : []),
  ].join('; ');

  // 11. Build the provider authorization URL
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/${slug}/callback`;

  const authParams = new URLSearchParams();
  authParams.set('client_id', clientId);
  authParams.set('redirect_uri', redirectUri);
  authParams.set('response_type', 'code');
  authParams.set('state', csrfState);

  if (requestedScopes.length > 0) {
    authParams.set('scope', requestedScopes.join(' '));
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

  // 12. Redirect with cookie
  const response = NextResponse.redirect(authUrl, 302);
  response.headers.set('Set-Cookie', cookieAttr);
  return response;
}
