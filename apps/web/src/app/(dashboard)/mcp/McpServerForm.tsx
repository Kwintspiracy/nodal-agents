'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createMcpServerFromCatalogAction, type McpCatalogItem } from '@/lib/actions.ts';

interface Props {
  /** Catalog entries available for new connections. */
  catalog: McpCatalogItem[];
}

/**
 * Inline form to connect a new MCP server from the catalog.
 * Multi-instance: every submit creates a new instance — the user can add
 * multiple servers of the same slug under different names.
 *
 * NOTE: The /mcp page now renders individual McpAddForm cards per catalog entry.
 * This component is kept for potential re-use (e.g. an agent edit sidebar).
 */
export default function McpServerForm({ catalog }: Props) {
  const [isPending, startTransition] = useTransition();
  const [slug, setSlug] = useState(catalog[0]?.slug ?? '');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');

  if (catalog.length === 0) {
    return null;
  }

  const selected = catalog.find((e) => e.slug === slug) ?? catalog[0];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    startTransition(async () => {
      const r = await createMcpServerFromCatalogAction({
        slug,
        name: trimmedName,
        apiKey: trimmedKey,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${trimmedName} connected`);
      setName('');
      setApiKey('');
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
            {catalog.map((e) => (
              <option key={e.slug} value={e.slug}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="mcp-name">
            Name
          </label>
          <input
            id="mcp-name"
            type="text"
            required
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            placeholder={selected?.label ?? ''}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
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

      {selected && (
        <p className="text-xs text-neutral-600">
          {selected.description} <span className="text-neutral-500">{selected.docsHint}</span>
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !name.trim() || !apiKey.trim()}
        className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
