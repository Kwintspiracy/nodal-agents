'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import Modal from '@/components/ui/Modal';
import McpInstalledTable from './McpInstalledTable.tsx';
import McpMarketplaceGrid from './McpMarketplaceGrid.tsx';
import McpAddForm from './McpAddForm.tsx';
import { mcpCategory } from './categories.ts';

type Tab = 'installed' | 'marketplace';

type Props = {
  instances: McpServerInstance[];
  catalog: McpCatalogItem[];
};

/**
 * McpClient — interactive shell for /mcp.
 * Mirrors ConnectorsClient exactly: PillTabs2 (Installed | Marketplace),
 * search, ChipRow filter on the Marketplace tab.
 */
export default function McpClient({ instances, catalog }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(instances.length > 0 ? 'installed' : 'marketplace');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

  // "Add custom MCP" — an always-visible entry point so users don't have to
  // hunt for the custom-* cards under the Marketplace "Custom" chip.
  const [customOpen, setCustomOpen] = useState(false);
  const [customFlavor, setCustomFlavor] = useState<'stdio' | 'http'>('stdio');
  const customHttp = catalog.find((c) => c.slug === 'custom-http-mcp');
  const customStdio = catalog.find((c) => c.slug === 'custom-stdio-mcp');
  const customItem = customFlavor === 'http' ? customHttp : customStdio;

  const filteredInstalled = useMemo(() => {
    if (!query.trim()) return instances;
    const q = query.toLowerCase();
    return instances.filter(
      (inst) => inst.name.toLowerCase().includes(q) || inst.slug.toLowerCase().includes(q),
    );
  }, [instances, query]);

  const filteredMarketplace = useMemo(() => {
    let items = catalog;
    if (category !== 'All') {
      items = items.filter((c) => mcpCategory(c.slug) === category);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter(
        (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      );
    }
    return items;
  }, [catalog, category, query]);

  return (
    <div className="pb-10">
      <PageHeader
        title="MCP Connectors"
        subtitle="Model Context Protocol servers your agents can call. Install from the marketplace or wire a custom HTTP / stdio server."
      />
      <PageTopBar
        tabs={
          <PillTabs2
            value={tab}
            onChange={(v) => {
              setTab(v);
              setQuery('');
              setCategory('All');
            }}
            tabs={[
              { value: 'installed', label: 'Installed', count: instances.length },
              { value: 'marketplace', label: 'Marketplace', count: catalog.length },
            ]}
          />
        }
        search={
          <PageSearchInput
            value={query}
            onChange={setQuery}
            placeholder={tab === 'installed' ? 'Search MCP servers…' : 'Search catalog…'}
          />
        }
        cta={
          <button
            type="button"
            onClick={() => setCustomOpen(true)}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-conn-vivid px-3.5 text-[14px] font-medium leading-none text-white transition-[filter] hover:brightness-[0.94]"
          >
            + Add custom MCP
          </button>
        }
      />

      <div className="pt-5">
        {tab === 'installed' ? (
          instances.length === 0 ? (
            <EmptyInstalled onBrowse={() => setTab('marketplace')} />
          ) : filteredInstalled.length === 0 ? (
            <EmptySearch />
          ) : (
            <McpInstalledTable instances={filteredInstalled} catalog={catalog} />
          )
        ) : (
          <McpMarketplaceGrid
            catalog={filteredMarketplace}
            instances={instances}
            category={category}
            onCategoryChange={setCategory}
          />
        )}
      </div>

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Add a custom MCP server">
        <div className="space-y-3">
          <div className="flex gap-2">
            {(['stdio', 'http'] as const).map((flavor) => (
              <button
                key={flavor}
                type="button"
                onClick={() => setCustomFlavor(flavor)}
                className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium ${
                  customFlavor === flavor
                    ? 'border-ink-3 bg-hover text-ink'
                    : 'border-rule bg-paper text-ink-3 hover:border-rule'
                }`}
              >
                {flavor === 'stdio' ? 'Local subprocess (stdio)' : 'Remote server (HTTP)'}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-ink-4">
            {customFlavor === 'stdio'
              ? 'Run any MCP package locally (npx, python, a binary…). Provide the command, args, and env vars.'
              : 'Connect any Streamable-HTTP MCP server. Provide the URL, auth scheme, and API key.'}
          </p>
          {customItem ? (
            <McpAddForm
              key={customFlavor}
              catalogItem={customItem}
              onDone={() => {
                setCustomOpen(false);
                router.refresh();
              }}
            />
          ) : (
            <p className="text-xs text-err">Custom MCP option is unavailable.</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[14px] leading-[1.5] text-ink-3">
        No MCP servers installed yet.
        <br />
        Pick one from the Marketplace — its tools become available to any agent you assign it to.
      </p>
      <div className="mt-4 inline-flex">
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-conn-vivid px-3.5 text-[14px] font-medium leading-none text-white transition-[filter] hover:brightness-[0.94]"
        >
          Browse Marketplace
        </button>
      </div>
    </div>
  );
}

function EmptySearch() {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[14px] leading-[1.5] text-ink-3">No servers match your search.</p>
    </div>
  );
}
