import {
  listCredentialsAction,
  deleteCredentialAction,
  renameCredentialAction,
  refreshCredentialAction,
} from '@/lib/credentials.ts';
import CredentialsClient from './CredentialsClient.tsx';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ created?: string }>;
}

export default async function CredentialsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const result = await listCredentialsAction();

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">Credentials</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <CredentialsClient
      credentials={result.data}
      justCreatedId={sp.created ?? null}
      onDelete={deleteCredentialAction}
      onRename={renameCredentialAction}
      onRefresh={refreshCredentialAction}
    />
  );
}
