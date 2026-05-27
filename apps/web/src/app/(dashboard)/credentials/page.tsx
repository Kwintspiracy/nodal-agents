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
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Credentials
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
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
