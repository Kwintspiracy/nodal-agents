'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { AgentRow } from '@/lib/actions.ts';

const CATEGORIES = ['preference', 'context', 'outcome', 'learned_rule'] as const;

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

  return (
    <div className="flex flex-wrap items-center gap-3 bg-neutral-900 border border-neutral-800/60 rounded-xl px-4 py-3">
      <div className="flex-1 min-w-[180px]">
        <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Agent
        </label>
        <select
          value={agentId}
          onChange={(e) => update({ agent: e.target.value || null })}
          disabled={isPending}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-w-[140px]">
        <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Category
        </label>
        <select
          value={category}
          onChange={(e) => update({ category: e.target.value || null })}
          disabled={isPending}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
        >
          <option value="">All</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-w-[160px]">
        <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Tag
        </label>
        <input
          type="text"
          defaultValue={tag}
          onBlur={(e) => update({ tag: e.target.value.trim() || null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          placeholder="any"
          disabled={isPending}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-300 mt-5 cursor-pointer">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => update({ archived: e.target.checked ? '1' : null })}
          disabled={isPending}
          className="accent-violet-500"
        />
        Show archived
      </label>
    </div>
  );
}
