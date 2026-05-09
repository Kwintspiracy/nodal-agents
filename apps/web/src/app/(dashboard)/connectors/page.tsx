import { listConnectorsAction } from '@/lib/actions.ts';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import ConnectorForm from './ConnectorForm.tsx';
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
    connected?: string;
    oauth_error?: string;
  }>;
}

export default async function ConnectorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const result = await listConnectorsAction();

  // Resolve label for ?connected={slug} from catalog.
  const connectedLabel = sp.connected
    ? (CONNECTOR_CATALOG.find((c) => c.slug === sp.connected)?.label ?? sp.connected)
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

  const connectedCount = result.data.filter((e) => e.connector?.active).length;
  const total = result.data.length;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* OAuth result notifications — client component fires toasts on mount */}
      <OAuthNotify successLabel={connectedLabel} errorMessage={errorMessage} />

      <div>
        <h1 className="text-2xl font-bold text-white">Connectors</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {connectedCount} of {total} connected
        </p>
      </div>

      <div className="space-y-3">
        {result.data.map((entry) => (
          <ConnectorForm key={entry.catalogSlug} entry={entry} />
        ))}
      </div>
    </div>
  );
}
