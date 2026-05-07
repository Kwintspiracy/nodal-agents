'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { deleteLlmKeyAction, type LlmKeyUiRow } from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';

interface Props {
  row: LlmKeyUiRow;
  onEdit: () => void;
  onDeleted: () => void;
}

export default function LlmKeyRow({ row, onEdit, onDeleted }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteLlmKeyAction(row.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('LLM provider removed');
      onDeleted();
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">
            {row.nickname ?? <span className="text-neutral-500 italic">no nickname</span>}
          </span>
          <ProviderBadge provider={row.provider} />
          {!row.isActive && (
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
              disabled
            </span>
          )}
          {row.isActive && (
            <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">
              active
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs">
          {row.defaultModel && (
            <span className="font-mono text-neutral-400 truncate">{row.defaultModel}</span>
          )}
          {row.baseUrl && (
            <span className="font-mono text-neutral-500 truncate">{row.baseUrl}</span>
          )}
          {row.hasApiKey ? (
            <span className="font-mono text-neutral-500" title="API key configured">
              •••
            </span>
          ) : (
            <span className="text-amber-400">no key</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-lg hover:border-neutral-700 hover:text-white transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="px-3 py-1.5 text-xs font-medium border border-red-900/40 text-red-400 rounded-lg hover:border-red-700 hover:text-red-300 transition-colors disabled:opacity-40"
        >
          Delete
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Remove LLM provider?"
        message={`"${row.nickname ?? row.provider}" will be removed. Agents using it will fall back to the default env-configured provider until reassigned.`}
        confirmLabel="Remove"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const cls = providerColor(provider);
  return (
    <span
      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {prettyProviderName(provider)}
    </span>
  );
}

function providerColor(p: string): string {
  switch (p) {
    case 'anthropic':
      return 'bg-amber-500/15 text-amber-400';
    case 'openai':
      return 'bg-emerald-500/15 text-emerald-400';
    case 'openai-compatible':
      return 'bg-violet-500/15 text-violet-400';
    case 'ollama':
      return 'bg-blue-500/15 text-blue-400';
    case 'openrouter':
      return 'bg-pink-500/15 text-pink-400';
    case 'google':
      return 'bg-cyan-500/15 text-cyan-400';
    case 'mistral':
      return 'bg-orange-500/15 text-orange-400';
    case 'groq':
      return 'bg-rose-500/15 text-rose-400';
    default:
      return 'bg-neutral-500/15 text-neutral-400';
  }
}
