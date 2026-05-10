import { redirect } from 'next/navigation';
import { listConnectorsAction, createOrAssignOAuthConnectorAction } from '@/lib/actions.ts';
import { listCredentialsAction } from '@/lib/credentials.ts';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import ConnectorForm, { type CompatibleCredential } from './ConnectorForm.tsx';
import OAuthNotify from './OAuthNotify.tsx';
import OAuthErrorBanner from './OAuthErrorBanner.tsx';

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
  user_denied: 'Access was denied by the provider. You can try again anytime.', // legacy alias
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
    /** Connector slug to auto-assign the new credential to (from wizard returnTo). */
    connectorSlug?: string;
    /** Credential ID to assign (from wizard returnTo / OAuth callback). */
    credentialId?: string;
    /** Emitted after server-side auto-assignment redirect — fires the success toast. */
    just_connected?: string;
    /** Legacy: slug that just connected via OAuth (used for toast label only). */
    connected?: string;
    oauth_error?: string;
    /** Provider-supplied error_description, forwarded as `detail` from the callback. */
    detail?: string;
  }>;
}

export default async function ConnectorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // ── Server-side credential auto-assignment ────────────────────────────────
  // When the OAuth callback redirects back with ?connectorSlug=X&credentialId=Y
  // we create-or-assign the credential to the connector, then redirect clean.
  if (sp.connectorSlug && sp.credentialId) {
    // createOrAssignOAuthConnectorAction upserts: it inserts a new connector row
    // if none exists yet (brand-new flow), or updates the existing one. This
    // ensures the card always shows CONNECTED + Refresh now after a wizard flow.
    await createOrAssignOAuthConnectorAction(sp.connectorSlug, sp.credentialId);
    // Redirect clean — strip params, pass a just_connected flag for the toast.
    redirect(`/connectors?just_connected=${sp.connectorSlug}`);
  }

  const result = await listConnectorsAction();

  // Resolve label for ?connected={slug} (legacy OAuth callback) or ?just_connected= (new flow).
  const connectedSlug = sp.connected ?? sp.just_connected;
  const connectedLabel = connectedSlug
    ? (CONNECTOR_CATALOG.find((c) => c.slug === connectedSlug)?.label ?? connectedSlug)
    : null;

  // Resolve error message for ?oauth_error={code}. If the provider supplied an
  // `error_description` (forwarded as `detail`) we append it for diagnostic precision.
  const baseError = sp.oauth_error
    ? (OAUTH_ERROR_MESSAGES[sp.oauth_error] ?? OAUTH_ERROR_MESSAGES['unknown'])
    : null;
  const errorMessage =
    baseError && sp.detail ? `${baseError} (Provider said: ${sp.detail})` : baseError;

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">Connectors</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  // ── Fetch all credentials once, group by type for passing to each form ────
  const credentialsResult = await listCredentialsAction();
  const allCredentials = credentialsResult.ok ? credentialsResult.data : [];

  // Group credentials by type for quick lookup.
  const credsByType = new Map<string, CompatibleCredential[]>();
  for (const cred of allCredentials) {
    const list = credsByType.get(cred.type) ?? [];
    list.push({ id: cred.id, name: cred.name, accountName: cred.accountName });
    credsByType.set(cred.type, list);
  }

  const connectedCount = result.data.filter((e) => e.connector?.active).length;
  const total = result.data.length;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* OAuth success — fires a toast and strips the URL so refresh doesn't re-fire. */}
      <OAuthNotify successLabel={connectedLabel} errorMessage={errorMessage} />

      {/* OAuth failure — persistent banner that stays until the user dismisses it. */}
      {errorMessage && sp.oauth_error && (
        <OAuthErrorBanner code={sp.oauth_error} message={errorMessage} />
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Connectors</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {connectedCount} of {total} connected
          </p>
        </div>
        <a
          href="/credentials"
          className="shrink-0 px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white transition-colors"
        >
          Manage credentials
        </a>
      </div>

      <div className="space-y-3">
        {result.data.map((entry) => {
          const catalogEntry = CONNECTOR_CATALOG.find((c) => c.slug === entry.catalogSlug);
          // For OAuth entries, find compatible credentials by credentialType.
          const compatibleCredentials = catalogEntry?.credentialType
            ? (credsByType.get(catalogEntry.credentialType) ?? [])
            : [];

          return (
            <ConnectorForm
              key={entry.catalogSlug}
              entry={entry}
              compatibleCredentials={compatibleCredentials}
              catalogEntry={
                catalogEntry ?? {
                  slug: entry.catalogSlug,
                  label: entry.label,
                  authType: entry.authType,
                  docsHint: entry.docsHint,
                }
              }
            />
          );
        })}
      </div>
    </div>
  );
}
