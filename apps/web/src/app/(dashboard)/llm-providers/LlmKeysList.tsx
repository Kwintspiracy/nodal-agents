'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl">
      {rows.length === 0 ? (
        <div className="px-6 py-8 text-center text-sm text-neutral-500">
          No LLM providers yet. Add one to start configuring agents.
        </div>
      ) : (
        <div className="divide-y divide-neutral-800/60">
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

      <div className="border-t border-neutral-800/60 px-5 py-3">
        {formState.kind === 'closed' && (
          <button
            type="button"
            onClick={() => setFormState({ kind: 'create' })}
            className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-300 rounded-lg hover:border-neutral-600 hover:text-white transition-colors"
          >
            + Add provider
          </button>
        )}
        {formState.kind === 'create' && (
          <LlmKeyForm
            mode="create"
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
    </div>
  );
}
