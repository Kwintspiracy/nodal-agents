'use client';

import { useMemo, useState } from 'react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import McpInstalledTable from './McpInstalledTable.tsx';
import McpMarketplaceGrid from './McpMarketplaceGrid.tsx';

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
  const [tab, setTab] = useState<Tab>(instances.length > 0 ? 'installed' : 'marketplace');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

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
    </div>
  );
}

/**
 * Maps an MCP catalog slug to one of the ChipRow category labels.
 */
export function mcpCategory(slug: string): string {
  if (slug === 'stripe') return 'Data';
  if (slug === 'composio') return 'Productivity';
  if (slug === 'cogni-cortex') return 'Comms';
  if (slug.startsWith('custom-')) return 'Custom';
  return 'Other';
}

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">
        No MCP servers installed yet.
        <br />
        Pick one from the Marketplace — its tools become available to any agent you assign it to.
      </p>
      <div className="mt-4 inline-flex">
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-conn-vivid px-3.5 text-[13px] font-medium leading-none text-white transition-[filter] hover:brightness-[0.94]"
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
      <p className="text-[13px] leading-[1.5] text-ink-3">No servers match your search.</p>
    </div>
  );
}
