import { listConnectorsAction } from '@/lib/actions.ts';
import ConnectorForm from './ConnectorForm.tsx';

export const dynamic = 'force-dynamic';

export default async function ConnectorsPage() {
  const result = await listConnectorsAction();

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
      <div>
        <h1 className="text-2xl font-bold text-white">Connectors</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {connectedCount} of {total} connected · paste credentials to enable adapter tools
        </p>
      </div>

      <div className="space-y-3">
        {result.data.map((entry) => (
          <ConnectorForm key={entry.catalogSlug} entry={entry} />
        ))}
      </div>

      <div className="bg-neutral-950 border border-neutral-800/40 rounded-xl px-5 py-4 text-xs text-neutral-500">
        <strong className="text-neutral-300 block mb-1">Note on OAuth</strong>
        The automated Google OAuth flow (redirect + callback) is not wired in yet — paste raw tokens
        generated elsewhere (e.g. via <code className="font-mono text-neutral-400">gcloud</code> or
        the OAuth playground). Adapter tools fetch a fresh access token from the refresh token at
        call-time.
      </div>
    </div>
  );
}
