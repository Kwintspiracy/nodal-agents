'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createMcpServerFromCatalogAction, type McpCatalogItem } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import FieldLabel from '@/components/ui/FieldLabel';

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
      className="bg-paper border border-rule-2 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-ink">Connect an MCP connector</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="mcp-slug">Connector</FieldLabel>
          <Select id="mcp-slug" value={slug} onChange={(ev) => setSlug(ev.target.value)}>
            {catalog.map((e) => (
              <option key={e.slug} value={e.slug}>
                {e.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
          <TextInput
            id="mcp-name"
            type="text"
            required
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            placeholder={selected?.label ?? ''}
          />
        </div>
      </div>

      <div>
        <FieldLabel htmlFor="mcp-key">API key</FieldLabel>
        <TextInput
          id="mcp-key"
          name="apiKey"
          type="password"
          required
          autoComplete="off"
          value={apiKey}
          onChange={(ev) => setApiKey(ev.target.value)}
          placeholder={selected ? `${selected.keyPrefix}…` : ''}
          className="font-mono"
        />
      </div>

      {selected && (
        <p className="text-xs text-ink-4">
          {selected.description} <span className="text-ink-3">{selected.docsHint}</span>
        </p>
      )}

      <PrimaryButton type="submit" disabled={isPending || !name.trim() || !apiKey.trim()}>
        {isPending ? 'Connecting…' : 'Connect'}
      </PrimaryButton>
    </form>
  );
}
