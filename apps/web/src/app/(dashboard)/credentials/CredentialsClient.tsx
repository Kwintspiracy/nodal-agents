'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import CredentialCard, { type CredentialEntry } from './CredentialCard.tsx';
import CredentialWizard from './CredentialWizard.tsx';
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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Credentials</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {credentials.length === 0
              ? 'No credentials yet — create one to connect OAuth providers.'
              : `${credentials.length} credential${credentials.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="shrink-0 px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
        >
          + New credential
        </button>
      </div>

      {credentials.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center">
          <p className="text-sm text-neutral-500">
            Credentials store your OAuth client ID and secret securely (encrypted at rest).
            <br />
            Once created, multiple connectors can share the same credential.
          </p>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="mt-4 px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
          >
            Create your first credential
          </button>
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
