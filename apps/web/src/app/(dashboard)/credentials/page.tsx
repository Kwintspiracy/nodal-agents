import {
  listCredentialsAction,
  deleteCredentialAction,
  renameCredentialAction,
  refreshCredentialAction,
} from '@/lib/credentials.ts';
import PageShell from '@/components/ui/PageShell';
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
      <PageShell title="Credentials">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
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
