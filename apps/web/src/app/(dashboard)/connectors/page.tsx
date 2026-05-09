import { redirect } from 'next/navigation';
import { listConnectorsAction, createOrAssignOAuthConnectorAction } from '@/lib/actions.ts';
import { listCredentialsAction } from '@/lib/credentials.ts';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import ConnectorForm, { type CompatibleCredential } from './ConnectorForm.tsx';
import OAuthNotify from './OAuthNotify.tsx';

export const dynamic = 'force-dynamic';

/** Maps ?oauth_error codes to user-friendly messages. */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_state: 'OAuth session was invalid. Please try connecting again.',
  state_mismatch: 'Security check failed (state mismatch). Please try connecting again.',
  session_lost: 'Your session expired during OAuth. Please sign in and try again.',
  user_denied: 'Access was denied by the provider. You can try again anytime.',
  token_exchange_failed:
    'Failed to exchange the authorisation code for a token. Check your Client Secret and try again.',
  unknown_provider: 'Unknown provider — the OAuth flow could not be started.',
  missing_code: 'No authorisation code was returned by the provider.',
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

  // Resolve error message for ?oauth_error={code}.
  const errorMessage = sp.oauth_error
    ? (OAUTH_ERROR_MESSAGES[sp.oauth_error] ?? OAUTH_ERROR_MESSAGES['unknown'])
    : null;

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
      {/* OAuth result notifications — client component fires toasts on mount */}
      <OAuthNotify successLabel={connectedLabel} errorMessage={errorMessage} />

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
