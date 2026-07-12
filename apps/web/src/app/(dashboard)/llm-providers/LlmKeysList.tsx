'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { type LlmKeyUiRow } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PrimaryButton from '@/components/ui/PrimaryButton';
import EmptyState from '@/components/ui/EmptyState';
import LlmKeyRow from './LlmKeyRow.tsx';
import LlmKeyForm from './LlmKeyForm.tsx';

interface Props {
  initialRows: LlmKeyUiRow[];
}

type FormState = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; row: LlmKeyUiRow };

export default function LlmKeysList({ initialRows }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [formState, setFormState] = useState<FormState>({ kind: 'closed' });
  const rows = initialRows;

  const configuredProviders = rows.map((r) => r.provider);

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <PageShell
      title="LLM Providers"
      subtitle="API keys for your model providers."
      toolbar={
        <PageTopBar
          cta={
            <PrimaryButton
              variant="neutral"
              onClick={() => setFormState({ kind: 'create' })}
              disabled={formState.kind === 'create'}
            >
              + New provider
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState title="No LLM providers yet. Add one with the “New provider” button above." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <LlmKeyRow
                key={row.id}
                row={row}
                onEdit={() => setFormState({ kind: 'edit', row })}
                onDeleted={refresh}
              />
            ))}
          </div>
        )}

        {formState.kind === 'create' && (
          <LlmKeyForm
            mode="create"
            configuredProviders={configuredProviders}
            onDone={(action) => {
              setFormState({ kind: 'closed' });
              if (action === 'saved') refresh();
            }}
          />
        )}
        {formState.kind === 'edit' && (
          <LlmKeyForm
            mode="edit"
            initial={formState.row}
            onDone={(action) => {
              setFormState({ kind: 'closed' });
              if (action === 'saved') refresh();
            }}
          />
        )}
      </div>
    </PageShell>
  );
}
