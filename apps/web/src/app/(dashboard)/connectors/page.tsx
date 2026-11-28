import { redirect } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import {
  listConnectorsAction,
  createOrAssignOAuthConnectorAction,
  assignCredentialAction,
} from '@/lib/actions.ts';
import { listCredentialsAction } from '@/lib/credentials.ts';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import { compatibleCredentialsBySlug } from '@/lib/connector-access.ts';
import OAuthNotify from './OAuthNotify.tsx';
import OAuthErrorBanner from './OAuthErrorBanner.tsx';
import ConnectorsClient from './ConnectorsClient.tsx';
import Banner from '@/components/ui/Banner';

export const dynamic = 'force-dynamic';

/** Maps ?oauth_error codes to user-friendly messages. Includes our internal codes plus
 * the standard OAuth 2.0 error codes that providers may return via the `error` query param. */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  // Internal codes
  invalid_state: 'OAuth session was invalid. Please try connecting again.',
  state_mismatch: 'Security check failed (state mismatch). Please try connecting again.',
  session_lost: 'Your session expired during OAuth. Please sign in and try again.',
  token_exchange_failed:
    'Failed to exchange the authorisation code for a token. Check your Client Secret and try again.',
  unknown_provider: 'Unknown provider — the OAuth flow could not be started.',
  missing_access:
    'The provider did not grant any of the access this connector needs. Connect again and keep its permissions ticked on the consent screen.',
  account_mismatch:
    'The provider answered for a different account than this credential. Sign in with the credential’s own account to add access, or create a new credential.',
  missing_code: 'No authorisation code was returned by the provider.',
  bind_failed:
    'The new credential was saved, but it could not be given to this connector. It is still not connected.',
  // Standard OAuth 2.0 error codes (RFC 6749 §4.1.2.1) — forwarded from provider
  access_denied: 'Access was denied by the provider. You can try again anytime.',
  user_denied: 'Access was denied by the provider. You can try again anytime.',
  invalid_request: 'The OAuth request was malformed. Try reconnecting.',
  invalid_scope:
    'Your OAuth integration is missing one or more scopes. Open the integration settings on the provider and grant the requested scopes, then try again.',
  invalid_client:
    'The Client ID or Client Secret is rejected by the provider. Recreate the credential with fresh values.',
  unauthorized_client:
    'Your OAuth integration is not authorised for this flow. Check the integration type (Public vs Internal) and redirect URI.',
  unsupported_response_type:
    'The provider rejected the response type. The integration is likely misconfigured.',
  server_error: 'The provider returned a server error. Try again in a moment.',
  temporarily_unavailable: 'The provider is temporarily unavailable. Try again shortly.',
  // Fallback
  unknown: 'An unexpected error occurred during OAuth. Please try again.',
};

interface PageProps {
  searchParams: Promise<{
    connectorSlug?: string;
    credentialId?: string;
    rebind?: string;
    just_connected?: string;
    connected?: string;
    oauth_error?: string;
    detail?: string;
  }>;
}

export default async function ConnectorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // ── Reconnect of a connector whose credential was gone or unreadable ──────
  // The new credential is bound to THAT connector row (its agents keep it),
  // and a refusal is shown as one, never announced as connected.
  if (sp.rebind && sp.credentialId) {
    const bound = await assignCredentialAction(sp.rebind, sp.credentialId);
    if (!bound.ok) {
      redirect(`/connectors?oauth_error=bind_failed&detail=${encodeURIComponent(bound.message)}`);
    }
    redirect(
      sp.connected ? `/connectors?connected=${encodeURIComponent(sp.connected)}` : '/connectors',
    );
  }

  // ── Server-side credential auto-assignment ────────────────────────────────
  if (sp.connectorSlug && sp.credentialId) {
    const bound = await createOrAssignOAuthConnectorAction(sp.connectorSlug, sp.credentialId);
    // A refused binding is said, never announced as "connected".
    if (!bound.ok) redirect(`/connectors?oauth_error=${encodeURIComponent(bound.code)}`);
    redirect(`/connectors?just_connected=${sp.connectorSlug}`);
  }

  const result = await listConnectorsAction();

  const connectedSlug = sp.connected ?? sp.just_connected;
  const connectedLabel = connectedSlug
    ? (CONNECTOR_CATALOG.find((c) => c.slug === connectedSlug)?.label ?? connectedSlug)
    : null;

  const baseError = sp.oauth_error
    ? (OAUTH_ERROR_MESSAGES[sp.oauth_error] ?? OAUTH_ERROR_MESSAGES['unknown'])
    : null;
  // A failed binding's detail is Nodal's own reason; any other detail is the
  // provider's words.
  const errorMessage =
    baseError && sp.detail
      ? sp.oauth_error === 'bind_failed'
        ? `${baseError} ${sp.detail}`
        : `${baseError} (Provider said: ${sp.detail})`
      : baseError;

  if (!result.ok) {
    return (
      <PageShell title="Connectors">
        <Banner variant="warn">{result.message}</Banner>
      </PageShell>
    );
  }

  const { instances, catalog } = result.data;

  // ── Fetch all credentials once; per connector, what each one grants it ────
  const credentialsResult = await listCredentialsAction();
  const allCredentials = credentialsResult.ok ? credentialsResult.data : [];
  const credsBySlug = compatibleCredentialsBySlug(catalog, allCredentials);

  return (
    <>
      {/* OAuth success — fires a toast and strips the URL so refresh doesn't re-fire. */}
      <OAuthNotify successLabel={connectedLabel} errorMessage={errorMessage} />

      {/* OAuth failure — persistent banner that stays until the user dismisses it. */}
      {errorMessage && sp.oauth_error && (
        <OAuthErrorBanner code={sp.oauth_error} message={errorMessage} />
      )}

      <ConnectorsClient instances={instances} catalog={catalog} credsBySlug={credsBySlug} />
    </>
  );
}
