'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from '@phosphor-icons/react';
import { type CredentialEntry } from './CredentialCard.tsx';
import CredentialsTable from './CredentialsTable.tsx';
import CredentialWizard from './CredentialWizard.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import type { ActionResult } from '@/lib/actions.ts';

interface Props {
  credentials: CredentialEntry[];
  justCreatedId: string | null;
  onDelete: (id: string) => Promise<ActionResult<{ disconnected: number }>>;
  onRename: (id: string, name: string) => Promise<ActionResult<void>>;
  onRefresh: (id: string) => Promise<ActionResult<{ expiresAt: Date | null }>>;
}

export default function CredentialsClient({
  credentials,
  justCreatedId,
  onDelete,
  onRename,
  onRefresh,
}: Props) {
  const router = useRouter();
  const fired = useRef(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Fire a success toast when landing from ?created= and strip the param.
  useEffect(() => {
    if (!justCreatedId || fired.current) return;
    fired.current = true;
    toast.success('Credential created');
    router.replace('/credentials');
  }, [justCreatedId, router]);

  return (
    <PageShell
      title="Credentials"
      subtitle="Saved authentications your connectors reuse."
      toolbar={
        <PageTopBar
          cta={
            <PrimaryButton variant="neutral" onClick={() => setWizardOpen(true)}>
              <Plus size={13} weight="bold" />
              New credential
            </PrimaryButton>
          }
        />
      }
    >
      {credentials.length === 0 ? (
        <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
          <p className="text-sm text-ink-3">
            Credentials store your OAuth client ID and secret securely (encrypted at rest).
            <br />
            Once created, multiple connectors can share the same credential.
          </p>
          <div className="mt-4 inline-flex">
            <PrimaryButton variant="ink" onClick={() => setWizardOpen(true)}>
              <Plus size={13} weight="bold" />
              Create your first credential
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <CredentialsTable
          credentials={credentials}
          onDelete={onDelete}
          onRename={onRename}
          onRefresh={onRefresh}
        />
      )}

      {wizardOpen && <CredentialWizard onClose={() => setWizardOpen(false)} />}
    </PageShell>
  );
}
