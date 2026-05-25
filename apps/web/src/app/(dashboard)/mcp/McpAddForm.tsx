'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createMcpServerFromCatalogAction, type McpCatalogItem } from '@/lib/actions.ts';

interface Props {
  catalogItem: McpCatalogItem;
}

/**
 * Marketplace card for a single MCP catalog entry.
 * Clicking "+ Add" expands a form: name (required) + apiKey (required).
 * Multiple instances of the same slug are allowed (multi-instance brique).
 */
export default function McpAddForm({ catalogItem }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('');

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    if (!trimmedKey) {
      toast.error('API key is required');
      return;
    }
    startTransition(async () => {
      const r = await createMcpServerFromCatalogAction({
        slug: catalogItem.slug,
        name: trimmedName,
        apiKey: trimmedKey,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${trimmedName} connected`);
      setOpen(false);
      setName('');
      setApiKey('');
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{catalogItem.label}</h3>
          <p className="text-[11px] text-neutral-500 font-mono mt-0.5">{catalogItem.slug}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-white text-black rounded-md hover:bg-neutral-200"
        >
          {open ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {catalogItem.description && (
        <p className="text-xs text-neutral-600">{catalogItem.description}</p>
      )}

      {open && (
        <form onSubmit={handleSubmit} className="space-y-3 pt-2 border-t border-neutral-800/60">
          <div>
            <label
              htmlFor={`mcp-name-${catalogItem.slug}`}
              className="block text-xs text-neutral-500 mb-1"
            >
              Name <span className="text-neutral-700">(e.g. &quot;Cortex — perso&quot;)</span>
            </label>
            <input
              id={`mcp-name-${catalogItem.slug}`}
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={catalogItem.label}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor={`mcp-key-${catalogItem.slug}`}
              className="block text-xs text-neutral-500 mb-1"
            >
              API key
            </label>
            <input
              id={`mcp-key-${catalogItem.slug}`}
              type="password"
              required
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`${catalogItem.keyPrefix}…`}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
            />
            {catalogItem.docsHint && (
              <p className="text-[11px] text-neutral-600 mt-1">{catalogItem.docsHint}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={isPending || !name.trim() || !apiKey.trim()}
            className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
          >
            {isPending ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
    </div>
  );
}
