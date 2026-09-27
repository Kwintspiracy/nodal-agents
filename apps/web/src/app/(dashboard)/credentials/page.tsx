import {
  listCredentialsAction,
  deleteCredentialAction,
  renameCredentialAction,
  refreshCredentialAction,
} from '@/lib/credentials.ts';
import PageShell from '@/components/ui/PageShell';
import CredentialsClient from './CredentialsClient.tsx';
import Banner from '@/components/ui/Banner';

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
        <Banner variant="warn">{result.message}</Banner>
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
