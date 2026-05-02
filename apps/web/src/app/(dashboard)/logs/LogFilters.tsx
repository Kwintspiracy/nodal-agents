'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { AgentRow } from '@/lib/actions.ts';

interface Props {
  agents: AgentRow[];
}

export default function LogFilters({ agents }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const agentId = search.get('agent') ?? '';
  const toolName = search.get('tool') ?? '';

  function update(next: Record<string, string | null>) {
    const params = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    params.delete('page');
    startTransition(() => {
      router.replace(`/logs?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3 bg-neutral-900 border border-neutral-800/60 rounded-xl px-4 py-3">
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

      <div className="flex-1 min-w-[200px]">
        <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Tool name
        </label>
        <input
          type="text"
          defaultValue={toolName}
          onBlur={(e) => update({ tool: e.target.value.trim() || null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          placeholder="e.g. notion_search"
          disabled={isPending}
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
        />
      </div>
    </div>
  );
}
