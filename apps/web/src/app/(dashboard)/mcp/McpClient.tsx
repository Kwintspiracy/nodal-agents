'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import ChipRow from '@/components/ui/ChipRow';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import EmptyState from '@/components/ui/EmptyState';
import { Plus } from '@phosphor-icons/react';
import Modal from '@/components/ui/Modal';
import McpInstalledTable from './McpInstalledTable.tsx';
import McpMarketplaceGrid from './McpMarketplaceGrid.tsx';
import McpAddForm from './McpAddForm.tsx';
import { mcpCategory } from './categories.ts';
import { CONNECTOR_CATEGORIES } from '../connectors/categories.ts';

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
    let items = instances;
    if (category !== 'All') items = items.filter((inst) => mcpCategory(inst.slug) === category);
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter(
        (inst) => inst.name.toLowerCase().includes(q) || inst.slug.toLowerCase().includes(q),
      );
    }
    return items;
  }, [instances, query, category]);

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
    <PageShell
      title="MCP Connectors"
      subtitle="MCP servers your agents can call."
      toolbar={
        <>
          <PageTopBar
            tabs={
              <PillTabs2
                value={tab}
                onChange={(v) => {
                  setTab(v);
                  setQuery('');
                }}
                tabs={[
                  { value: 'installed', label: 'Installed', count: instances.length },
                  { value: 'marketplace', label: 'Library', count: catalog.length },
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
              <PrimaryButton variant="blue" onClick={() => setCustomOpen(true)}>
                <Plus size={13} weight="bold" />
                New MCP
              </PrimaryButton>
            }
          />
          <ChipRow
            className="mt-3"
            items={CONNECTOR_CATEGORIES}
            value={category}
            onChange={setCategory}
          />
        </>
      }
    >
      {tab === 'installed' ? (
        instances.length === 0 ? (
          <EmptyInstalled onBrowse={() => setTab('marketplace')} />
        ) : filteredInstalled.length === 0 ? (
          <EmptySearch />
        ) : (
          <McpInstalledTable instances={filteredInstalled} catalog={catalog} />
        )
      ) : (
        <McpMarketplaceGrid catalog={filteredMarketplace} instances={instances} />
      )}

      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Add a custom MCP server"
        dismissable={false}
      >
        <div className="space-y-3">
          <SegmentedControl
            value={customFlavor}
            onChange={setCustomFlavor}
            ariaLabel="Custom MCP server type"
            options={[
              { value: 'stdio', label: 'Local subprocess (stdio)' },
              { value: 'http', label: 'Remote server (HTTP)' },
            ]}
          />
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
              onCancel={() => setCustomOpen(false)}
            />
          ) : (
            <p className="text-xs text-err">Custom MCP option is unavailable.</p>
          )}
        </div>
      </Modal>
    </PageShell>
  );
}

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <EmptyState
      title="No MCP servers installed yet."
      description="Pick one from the Marketplace, its tools become available to any agent you assign it to."
      action={
        <PrimaryButton variant="blue" onClick={onBrowse}>
          Browse Marketplace
        </PrimaryButton>
      }
    />
  );
}

function EmptySearch() {
  return <EmptyState title="No servers match your search." />;
}
