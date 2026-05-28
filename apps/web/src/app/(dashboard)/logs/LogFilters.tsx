'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { AgentRow } from '@/lib/actions.ts';

interface Props {
  agents: AgentRow[];
  toolNames: string[];
}

export default function LogFilters({ agents, toolNames }: Props) {
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
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-rule-2 bg-paper px-4 py-3">
      <div className="min-w-[180px] flex-1">
        <label className="mb-1 block text-[10px] uppercase tracking-wider text-ink-3">Agent</label>
        <select
          value={agentId}
          onChange={(e) => update({ agent: e.target.value || null })}
          disabled={isPending}
          className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-[200px] flex-1">
        <label className="mb-1 block text-[10px] uppercase tracking-wider text-ink-3">
          Tool name
        </label>
        <select
          value={toolName}
          onChange={(e) => update({ tool: e.target.value || null })}
          disabled={isPending}
          className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 font-mono text-sm text-ink focus:border-ink-3 focus:outline-none"
        >
          <option value="">All tools</option>
          {toolNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
