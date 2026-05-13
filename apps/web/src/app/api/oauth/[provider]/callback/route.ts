// GET /api/oauth/[provider]/callback
// Handles the OAuth provider redirect: verifies CSRF state, exchanges the
// authorization code for tokens, fetches account info, persists a credentials
// row via persistCredentialFromOauthFlow, and redirects back to the dashboard.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { decrypt } from '@nodal-agents/secrets';
import { getAuthProvider } from '@/lib/server.ts';
import { getOAuthProvider, getProviderByCredentialType } from '@/lib/oauth-providers.ts';
import { verifyStateCookie, STATE_COOKIE_NAME } from '@/lib/oauth-state.ts';
import { persistCredentialFromOauthFlow } from '@/lib/credentials.ts';
import type { CredentialType } from '@nodal-agents/shared';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redirectError(origin: string, code: string, detail?: string): Response {
  // Always log error redirects so the dev terminal surfaces the failure even
  // when the toast on the dashboard disappears before the user can read it.
  console.error(`[oauth callback] error ${code}${detail ? ` — ${detail}` : ''}`);
  const u = new URLSearchParams();
  u.set('oauth_error', code);
  if (detail) u.set('detail', detail);
  return NextResponse.redirect(`${origin}/connectors?${u.toString()}`, 302);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Merge credentialId into an existing URL's query string.
 * If `returnTo` already has query params they are preserved.
 */
function buildRedirectUrl(
  returnTo: string | undefined,
  credentialId: string,
  origin: string,
): string {
  if (returnTo) {
    try {
      // returnTo may be relative (e.g. /connectors?connected=google-drive)
      const base = returnTo.startsWith('http') ? returnTo : `${origin}${returnTo}`;
      const url = new URL(base);
      url.searchParams.set('credentialId', credentialId);
      // Return as path+query if it was a relative URL originally
      if (!returnTo.startsWith('http')) {
        return `${url.pathname}${url.search}`;
      }
      return url.toString();
    } catch {
      // Fall through to default
    }
  }
  return `${origin}/credentials?created=${credentialId}`;
}

// ─── Token exchange types ─────────────────────────────────────────────────────

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

type NotionTokenResponse = {
  access_token: string;
  bot_id?: string;
  workspace_name?: string;
  workspace_id?: string;
  owner?: {
    type?: string;
    user?: {
      name?: string;
    };
  };
};

type TokenResponse = GoogleTokenResponse | NotionTokenResponse;

function isNotionResponse(r: TokenResponse): r is NotionTokenResponse {
  return (
    'workspace_name' in r || ('owner' in r && typeof (r as NotionTokenResponse).owner === 'object')
  );
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: slug } = await params;
  const url = new URL(req.url);
  const origin = url.origin;

  // 1. Resolve provider — slug can be either a catalog connector slug (e.g. 'google-drive')
  // or a credentialType (e.g. 'google-oauth') when wizard-initiated via credential type.
  const provider =
    getOAuthProvider(slug) ??
    getProviderByCredentialType(slug as import('@nodal-agents/shared').CredentialType);
  if (!provider) {
    return redirectError(origin, 'unknown_provider');
  }

  // 2. Read + verify state cookie
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMap = Object.fromEntries(
    cookieHeader.split(';').map((s) => {
      const idx = s.indexOf('=');
      return idx === -1 ? [s.trim(), ''] : [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
    }),
  );
  const rawCookie = cookieMap[STATE_COOKIE_NAME];
  if (!rawCookie) {
    return redirectError(origin, 'invalid_state');
  }

  const payload = verifyStateCookie(rawCookie);
  if (!payload) {
    return redirectError(origin, 'invalid_state');
  }

  // 3. Check for provider-side error. The OAuth spec defines several error codes
  // returned via the `error` query param. We forward the provider's code as our
  // own oauth_error code so the dashboard can show a specific message; the
  // human-readable `error_description` is forwarded as `detail`.
  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    const errorDescription = url.searchParams.get('error_description') ?? undefined;
    return redirectError(origin, errorParam, errorDescription);
  }

  // 4. Verify CSRF state (constant-time)
  const queryState = url.searchParams.get('state') ?? '';
  if (!constantTimeEqual(payload.state, queryState)) {
    return redirectError(origin, 'state_mismatch');
  }

  // 5. Verify session matches payload entityId
  let sessionUserId: string;
  let sessionEntityId: string;
  try {
    const session = await getAuthProvider().getSession(req);
    if (!session) {
      return redirectError(origin, 'session_lost');
    }
    sessionUserId = session.userId;
    sessionEntityId = session.entityId;
  } catch {
    return redirectError(origin, 'session_lost');
  }

  if (sessionEntityId !== payload.entityId) {
    return redirectError(origin, 'session_lost');
  }

  // 6. Decrypt clientSecret from cookie payload
  let clientSecret: string;
  try {
    clientSecret = decrypt(payload.clientSecretEnc);
  } catch (err) {
    console.error('[oauth callback] failed to decrypt clientSecret', err);
    return redirectError(origin, 'token_exchange_failed');
  }

  const code = url.searchParams.get('code') ?? '';
  const redirectUri = `${origin}/api/oauth/${slug}/callback`;

  // 7. Exchange code for tokens
  // E2E test bypass: codes starting with "mock-" are synthetic (never issued by real
  // OAuth providers). When detected, skip the token endpoint call and return a
  // deterministic mock response so Playwright tests can exercise the full callback
  // path (state verification, credential persistence, redirect) without real provider
  // credentials. Real provider codes never start with "mock-".
  let tokenResponse: TokenResponse;
  const isTestBypass = code.startsWith('mock-');
  if (isTestBypass) {
    tokenResponse = {
      access_token: `mock-at-${Date.now()}`,
      refresh_token: `mock-rt-${Date.now()}`,
      expires_in: 3600,
      scope: provider.scopes.join(' '),
      token_type: 'Bearer',
    } as GoogleTokenResponse;
  } else {
    try {
      tokenResponse = await exchangeCode({
        provider,
        code,
        redirectUri,
        codeVerifier: payload.codeVerifier,
        clientId: payload.clientId,
        clientSecret,
      });
    } catch (err) {
      console.error('[oauth callback] token exchange failed', err);
      return redirectError(origin, 'token_exchange_failed');
    }
  }

  // 8. Parse token fields
  const accessToken = (tokenResponse as GoogleTokenResponse).access_token;
  if (!accessToken) {
    console.error('[oauth callback] token response missing access_token', tokenResponse);
    return redirectError(origin, 'token_exchange_failed');
  }

  const refreshToken = (tokenResponse as GoogleTokenResponse).refresh_token ?? null;
  const expiresIn = (tokenResponse as GoogleTokenResponse).expires_in;
  const expiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;
  const scopeStr = (tokenResponse as GoogleTokenResponse).scope ?? null;

  // 9. Resolve account name
  let accountName: string | null = null;
  if (provider.accountInfo) {
    try {
      const infoRes = await fetch(provider.accountInfo.url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as Record<string, unknown>;
        const email =
          provider.accountInfo.emailField != null
            ? ((info[provider.accountInfo.emailField] as string | undefined) ?? null)
            : null;
        const name = (info[provider.accountInfo.nameField] as string | undefined) ?? null;
        accountName = email ?? name;
      } else {
        console.error('[oauth callback] accountInfo fetch failed', infoRes.status);
      }
    } catch (err) {
      console.error('[oauth callback] accountInfo fetch error', err);
    }
  } else if (isNotionResponse(tokenResponse)) {
    // Notion: extract from token response itself
    const notionRes = tokenResponse as NotionTokenResponse;
    accountName = notionRes.workspace_name ?? notionRes.owner?.user?.name ?? null;
  }

  // 10. Build credential payload
  const credentialPayload = {
    clientId: payload.clientId,
    clientSecret,
    refreshToken,
    accessToken,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    scopes: scopeStr ?? (provider.scopes.length > 0 ? provider.scopes.join(' ') : ''),
    accountName: accountName ?? '',
    tokenUrl: provider.tokenUrl,
  };

  // 11. Persist credential (creates a new credentials row, never upserts)
  let credentialId: string;
  try {
    const credentialName = payload.name ?? `${provider.label} (${accountName ?? 'Unknown'})`;
    const result = await persistCredentialFromOauthFlow({
      ownerUserId: sessionUserId,
      credentialType: payload.credentialType as CredentialType,
      name: credentialName,
      payload: credentialPayload,
    });
    credentialId = result.id;
  } catch (err) {
    console.error('[oauth callback] persistCredentialFromOauthFlow failed', err);
    return redirectError(origin, 'token_exchange_failed');
  }

  // 12. Clear state cookie + redirect
  const clearCookie = `${STATE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  const redirectTarget = buildRedirectUrl(payload.returnTo, credentialId, origin);
  const response = NextResponse.redirect(
    redirectTarget.startsWith('http') ? redirectTarget : `${origin}${redirectTarget}`,
    302,
  );
  response.headers.set('Set-Cookie', clearCookie);
  return response;
}

// ─── Token exchange helper ────────────────────────────────────────────────────

async function exchangeCode(opts: {
  provider: import('@/lib/oauth-providers.ts').OAuthProvider;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const { provider, code, redirectUri, codeVerifier, clientId, clientSecret } = opts;

  let body: string;
  let contentType: string;
  const headers: Record<string, string> = {};

  if (provider.tokenBodyType === 'json') {
    // Notion: JSON body + Basic auth header
    const jsonBody: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    };
    if (codeVerifier) {
      jsonBody['code_verifier'] = codeVerifier;
    }
    body = JSON.stringify(jsonBody);
    contentType = 'application/json';
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  } else {
    // Google / Airtable (and any 'form' provider): form-encoded body
    const formBody = new URLSearchParams();
    formBody.set('grant_type', 'authorization_code');
    formBody.set('code', code);
    formBody.set('redirect_uri', redirectUri);
    if (codeVerifier) {
      formBody.set('code_verifier', codeVerifier);
    }
    if (provider.tokenAuth === 'body') {
      formBody.set('client_id', clientId);
      formBody.set('client_secret', clientSecret);
    } else {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }
    body = formBody.toString();
    contentType = 'application/x-www-form-urlencoded';
  }

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...headers },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new Error(`Token endpoint returned ${res.status}: ${text}`);
  }

  return (await res.json()) as TokenResponse;
}
