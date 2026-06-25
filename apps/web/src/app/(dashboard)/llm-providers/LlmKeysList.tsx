'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from '@phosphor-icons/react';
import { type LlmKeyUiRow } from '@/lib/actions.ts';
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
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-[14px] text-ink-3">
          No LLM providers yet. Add one to start configuring agents.
        </div>
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

      {formState.kind === 'closed' && (
        <button
          type="button"
          onClick={() => setFormState({ kind: 'create' })}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md border border-rule bg-paper px-3.5 text-[14px] font-medium text-ink-2 transition-colors hover:border-rule-2 hover:text-ink"
        >
          <Plus size={13} weight="bold" />
          Add provider
        </button>
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
  );
}
