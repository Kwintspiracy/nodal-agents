import { redirect } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import { listConnectorsAction, createOrAssignOAuthConnectorAction } from '@/lib/actions.ts';
import { listCredentialsAction } from '@/lib/credentials.ts';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import OAuthNotify from './OAuthNotify.tsx';
import OAuthErrorBanner from './OAuthErrorBanner.tsx';
import ConnectorsClient from './ConnectorsClient.tsx';
import type { CompatibleCredential } from './ConnectorForm.tsx';

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
  missing_code: 'No authorisation code was returned by the provider.',
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
    just_connected?: string;
    connected?: string;
    oauth_error?: string;
    detail?: string;
  }>;
}

export default async function ConnectorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // ── Server-side credential auto-assignment ────────────────────────────────
  if (sp.connectorSlug && sp.credentialId) {
    await createOrAssignOAuthConnectorAction(sp.connectorSlug, sp.credentialId);
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
  const errorMessage =
    baseError && sp.detail ? `${baseError} (Provider said: ${sp.detail})` : baseError;

  if (!result.ok) {
    return (
      <PageShell title="Connectors">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  const { instances, catalog } = result.data;

  // ── Fetch all credentials once, group by type ──────────────────────────────
  const credentialsResult = await listCredentialsAction();
  const allCredentials = credentialsResult.ok ? credentialsResult.data : [];

  const credsByTypeMap = new Map<string, CompatibleCredential[]>();
  for (const cred of allCredentials) {
    const list = credsByTypeMap.get(cred.type) ?? [];
    list.push({ id: cred.id, name: cred.name, accountName: cred.accountName });
    credsByTypeMap.set(cred.type, list);
  }
  // Convert Map to plain object for client serialisation
  const credsByType: Record<string, CompatibleCredential[]> = Object.fromEntries(credsByTypeMap);

  return (
    <>
      {/* OAuth success — fires a toast and strips the URL so refresh doesn't re-fire. */}
      <OAuthNotify successLabel={connectedLabel} errorMessage={errorMessage} />

      {/* OAuth failure — persistent banner that stays until the user dismisses it. */}
      {errorMessage && sp.oauth_error && (
        <OAuthErrorBanner code={sp.oauth_error} message={errorMessage} />
      )}

      <ConnectorsClient instances={instances} catalog={catalog} credsByType={credsByType} />
    </>
  );
}
