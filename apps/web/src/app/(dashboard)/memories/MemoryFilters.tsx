'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { AgentRow } from '@/lib/actions.ts';

const CATEGORIES = ['preference', 'context', 'outcome', 'learned_rule'] as const;

const CATEGORY_LABEL: Record<(typeof CATEGORIES)[number], string> = {
  preference: 'Preference',
  context: 'Context',
  outcome: 'Outcome',
  learned_rule: 'Rule',
};

interface Props {
  agents: AgentRow[];
}

export default function MemoryFilters({ agents }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const agentId = search.get('agent') ?? '';
  const category = search.get('category') ?? '';
  const tag = search.get('tag') ?? '';
  const archived = search.get('archived') === '1';

  function update(next: Record<string, string | null>) {
    const params = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    // Reset pagination when filters change
    params.delete('page');
    startTransition(() => {
      router.replace(`/memories?${params.toString()}`);
    });
  }

  const selectCls =
    'w-full rounded-md border border-rule-2 bg-canvas px-2.5 py-1.5 text-[13px] text-ink focus:border-rule focus:outline-none disabled:opacity-50 transition-colors';
  const inputCls =
    'w-full rounded-md border border-rule-2 bg-canvas px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-4 focus:border-rule focus:outline-none disabled:opacity-50 transition-colors';
  const labelCls = 'mb-1 block font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-4';

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-rule-2 bg-paper px-4 py-3.5">
      {/* Agent filter ------------------------------------------------- */}
      <div className="min-w-[180px] flex-1">
        <label className={labelCls}>Agent</label>
        <select
          value={agentId}
          onChange={(e) => update({ agent: e.target.value || null })}
          disabled={isPending}
          className={selectCls}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {/* Category filter ---------------------------------------------- */}
      <div className="min-w-[140px] flex-1">
        <label className={labelCls}>Category</label>
        <select
          value={category}
          onChange={(e) => update({ category: e.target.value || null })}
          disabled={isPending}
          className={selectCls}
        >
          <option value="">All</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>

      {/* Tag filter --------------------------------------------------- */}
      <div className="min-w-[160px] flex-1">
        <label className={labelCls}>Tag</label>
        <input
          type="text"
          defaultValue={tag}
          onBlur={(e) => update({ tag: e.target.value.trim() || null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          placeholder="any"
          disabled={isPending}
          className={inputCls}
        />
      </div>

      {/* Archived toggle ---------------------------------------------- */}
      <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-[13px] text-ink-2">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => update({ archived: e.target.checked ? '1' : null })}
          disabled={isPending}
          className="accent-[var(--c-conn-vivid)]"
        />
        Show archived
      </label>
    </div>
  );
}
