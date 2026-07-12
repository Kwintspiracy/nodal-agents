'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PencilSimple, Trash } from '@phosphor-icons/react';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import { deleteLlmKeyAction, setLlmKeyActiveAction, type LlmKeyUiRow } from '@/lib/actions.ts';
import { prettyProviderName } from '@/lib/provider-names.ts';

interface Props {
  row: LlmKeyUiRow;
  onEdit: () => void;
  onDeleted: () => void;
}

export default function LlmKeyRow({ row, onEdit, onDeleted }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [togglingActive, startToggleTransition] = useTransition();

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

  function handleToggleActive() {
    startToggleTransition(async () => {
      const r = await setLlmKeyActiveAction(row.id, !row.isActive);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.refresh();
    });
  }

  const { bg, fg, initials } = providerGlyph(row.provider);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-rule-2 bg-paper p-[18px]">
      {/* Header row: glyph + name + status */}
      <div className="flex items-center gap-3">
        {/* Provider glyph */}
        <div
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl font-mono text-[14px] font-semibold tracking-[0.04em]"
          style={{ background: bg, color: fg }}
        >
          {initials}
        </div>

        {/* Name + region */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-semibold leading-[1.2] tracking-[-0.005em] text-ink">
              {row.nickname ?? prettyProviderName(row.provider)}
            </span>
            {row.nickname && (
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-4">
                {prettyProviderName(row.provider)}
              </span>
            )}
          </div>
        </div>

        {/* Active toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={row.isActive}
          aria-label={row.isActive ? 'Deactivate provider' : 'Activate provider'}
          onClick={handleToggleActive}
          disabled={togglingActive || isPending}
          className={[
            'relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            row.isActive ? 'border-ok/40 bg-ok/20' : 'border-rule-2 bg-canvas',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform',
              row.isActive ? 'translate-x-[18px] bg-ok' : 'translate-x-[2px] bg-ink-4',
            ].join(' ')}
          />
        </button>
      </div>

      {/* Detail row: base URL + API key indicator */}
      <div className="flex flex-col gap-1">
        {row.baseUrl && (
          <div className="flex items-center gap-2 rounded-lg bg-canvas px-[10px] py-[7px]">
            <code className="flex-1 truncate font-mono text-[13px] leading-none text-ink">
              {row.baseUrl}
            </code>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg bg-canvas px-[10px] py-[7px]">
          {row.hasApiKey ? (
            <code className="font-mono text-[13px] leading-none tracking-widest text-ink-3">
              ••••••••{row.apiKeyLast4 ?? ''}
            </code>
          ) : (
            <span className="text-[13px] leading-none text-warn">No API key</span>
          )}
        </div>
      </div>

      {/* Footer row: agent usage + actions */}
      <div className="flex items-center justify-between border-t border-rule-2 pt-[10px]">
        <AgentUsage count={row.agentCount} keyId={row.id} />
        <div className="flex items-center gap-1.5">
          <RowActionButton square icon={<PencilSimple size={16} />} title="Edit" onClick={onEdit} />
          <RowActionButton
            square
            icon={<Trash size={16} />}
            title="Delete"
            tone="danger"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Remove LLM provider?"
        message={`"${row.nickname ?? prettyProviderName(row.provider)}" will be removed. Agents using it will fall back to the default env-configured provider until reassigned.`}
        confirmLabel="Remove"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function AgentUsage({ count, keyId }: { count: number; keyId: string }) {
  if (count === 0) {
    return <span className="font-sans text-[13px] leading-none text-ink-3">Not in use</span>;
  }
  return (
    <Link
      href={`/agents?llmKeyId=${keyId}`}
      className="font-sans text-[13px] leading-none text-ink-3 transition-colors hover:text-ink"
      title={`${count} agent${count === 1 ? '' : 's'} use this key`}
    >
      <span className="font-mono tabular-nums">{count}</span> agent{count === 1 ? '' : 's'} using
    </Link>
  );
}

/** Per-provider glyph: 2-char initials + brand-adjacent colour.
 *  Colours respect the design's restraint — muted / desaturated versions
 *  of each brand's identity colour, never garish. */
function providerGlyph(p: string): { bg: string; fg: string; initials: string } {
  switch (p) {
    case 'anthropic':
      // Warm clay — Anthropic's sand/terracotta palette
      return { bg: '#c96442', fg: '#fff', initials: 'AN' };
    case 'openai':
      // Muted green — OpenAI's signature
      return { bg: '#0fa47c', fg: '#fff', initials: 'OA' };
    case 'openai-compatible':
      // Soft violet for local/custom
      return { bg: '#7c5cbf', fg: '#fff', initials: 'LC' };
    case 'ollama':
      // Slate blue — neutral for local inference
      return { bg: '#3b5a8a', fg: '#fff', initials: 'OL' };
    case 'openrouter':
      // Deep rose — OpenRouter brand
      return { bg: '#b5455a', fg: '#fff', initials: 'OR' };
    case 'google':
      // Google blue
      return { bg: '#1a73c8', fg: '#fff', initials: 'GG' };
    case 'mistral':
      // Amber orange — Mistral brand
      return { bg: '#c47a1a', fg: '#fff', initials: 'MI' };
    case 'groq':
      // Dark rose
      return { bg: '#a33b50', fg: '#fff', initials: 'GQ' };
    default:
      return { bg: '#4a4a50', fg: '#fff', initials: p.slice(0, 2).toUpperCase() };
  }
}
