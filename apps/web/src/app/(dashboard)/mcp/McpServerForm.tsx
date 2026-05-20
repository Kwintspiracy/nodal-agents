'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  createMcpServerFromCatalogAction,
  type McpServerListEntry,
} from '@/lib/actions.ts';

interface Props {
  /** Catalog entries not yet connected for this entity. */
  available: McpServerListEntry[];
}

export default function McpServerForm({ available }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [slug, setSlug] = useState(available[0]?.catalogSlug ?? '');
  const [apiKey, setApiKey] = useState('');

  if (available.length === 0) {
    return (
      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-4 text-sm text-neutral-500">
        Every MCP connector in the catalog is connected.
      </div>
    );
  }

  const selected = available.find((e) => e.catalogSlug === slug) ?? available[0];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    startTransition(async () => {
      const r = await createMcpServerFromCatalogAction({ slug, apiKey: apiKey.trim() });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${selected?.label ?? 'MCP connector'} connected`);
      form.reset();
      setApiKey('');
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-white">Connect an MCP connector</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="mcp-slug">
            Connector
          </label>
          <select
            id="mcp-slug"
            value={slug}
            onChange={(ev) => setSlug(ev.target.value)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            {available.map((e) => (
              <option key={e.catalogSlug} value={e.catalogSlug}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="mcp-key">
            API key
          </label>
          <input
            id="mcp-key"
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            placeholder={selected ? `${selected.keyPrefix}…` : ''}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
          />
        </div>
      </div>

      {selected && (
        <p className="text-xs text-neutral-600">
          {selected.description} <span className="text-neutral-500">{selected.docsHint}</span>
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || apiKey.trim() === ''}
        className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
