'use client';

import { useMemo, useState } from 'react';
import type { ConnectorRow, ConnectorCatalogItem } from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import ChipRow from '@/components/ui/ChipRow';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import EmptyState from '@/components/ui/EmptyState';
import ConnectorsInstalledTable from './ConnectorsInstalledTable.tsx';
import ConnectorsMarketplaceGrid from './ConnectorsMarketplaceGrid.tsx';
import { catalogCategory, CONNECTOR_CATEGORIES } from './categories.ts';

type Tab = 'installed' | 'marketplace';

type Props = {
  instances: ConnectorRow[];
  catalog: ConnectorCatalogItem[];
  credsByType: Record<string, CompatibleCredential[]>;
};

/**
 * ConnectorsClient — interactive shell for /connectors.
 * Mirrors screen-conn.jsx v4: PillTabs2 (Installed | Marketplace), search,
 * ChipRow category filter on the Marketplace tab.
 */
export default function ConnectorsClient({ instances, catalog, credsByType }: Props) {
  const [tab, setTab] = useState<Tab>(instances.length > 0 ? 'installed' : 'marketplace');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

  const filteredInstalled = useMemo(() => {
    let items = instances;
    if (category !== 'All') items = items.filter((inst) => catalogCategory(inst.slug) === category);
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter(
        (inst) =>
          inst.name.toLowerCase().includes(q) ||
          inst.slug.toLowerCase().includes(q) ||
          (inst.credentialAccountName ?? '').toLowerCase().includes(q),
      );
    }
    return items;
  }, [instances, query, category]);

  const filteredMarketplace = useMemo(() => {
    let items = catalog;
    if (category !== 'All') {
      items = items.filter((c) => catalogCategory(c.slug) === category);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      items = items.filter(
        (c) => c.label.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q),
      );
    }
    return items;
  }, [catalog, category, query]);

  return (
    <PageShell
      title="API Connectors"
      subtitle="Wire your agents to external services."
      toolbar={
        <>
          {/* Pas de CTA "+ New connector" : un connecteur API s'installe depuis
              la Library (onglet ci-contre), il ne se crée pas depuis l'UI — le
              custom passe par un MCP server (page MCP). Décision 2026-07-16 :
              l'ancien bouton ne faisait que setTab('marketplace'), un faux
              verbe de création. */}
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
                placeholder={tab === 'installed' ? 'Search connectors…' : 'Search providers…'}
              />
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
          <ConnectorsInstalledTable instances={filteredInstalled} credsByType={credsByType} />
        )
      ) : (
        <ConnectorsMarketplaceGrid
          catalog={filteredMarketplace}
          instances={instances}
          credsByType={credsByType}
        />
      )}
    </PageShell>
  );
}

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <EmptyState
      title="No connectors installed yet."
      description="Browse the Marketplace to add one."
      action={
        <PrimaryButton variant="blue" onClick={onBrowse}>
          Browse Marketplace
        </PrimaryButton>
      }
    />
  );
}

function EmptySearch() {
  return <EmptyState title="No connectors match your search." />;
}
