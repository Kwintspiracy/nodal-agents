'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from '@phosphor-icons/react';
import CredentialCard, { type CredentialEntry } from './CredentialCard.tsx';
import CredentialWizard from './CredentialWizard.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
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
    <div className="py-7">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
            Credentials
          </h1>
          <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">
            {credentials.length === 0
              ? 'No credentials yet — create one to connect OAuth providers.'
              : `${credentials.length} credential${credentials.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <PrimaryButton variant="ink" onClick={() => setWizardOpen(true)}>
          <Plus size={13} weight="bold" />
          New credential
        </PrimaryButton>
      </div>

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
        <div className="space-y-3">
          {credentials.map((cred) => (
            <CredentialCard
              key={cred.id}
              credential={cred}
              onDelete={onDelete}
              onRename={onRename}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      {wizardOpen && <CredentialWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
