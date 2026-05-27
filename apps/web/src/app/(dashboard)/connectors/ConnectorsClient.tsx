'use client';

import { useMemo, useState } from 'react';
import type { ConnectorRow, ConnectorCatalogItem } from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import ConnectorsInstalledTable from './ConnectorsInstalledTable.tsx';
import ConnectorsMarketplaceGrid from './ConnectorsMarketplaceGrid.tsx';

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
    if (!query.trim()) return instances;
    const q = query.toLowerCase();
    return instances.filter(
      (inst) =>
        inst.name.toLowerCase().includes(q) ||
        inst.slug.toLowerCase().includes(q) ||
        (inst.credentialAccountName ?? '').toLowerCase().includes(q),
    );
  }, [instances, query]);

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
    <div className="pb-10">
      <PageHeader
        title="API Connectors"
        subtitle="Wire your agents to external services — Gmail, Slack, HubSpot, and the rest. Browse the marketplace or manage the accounts you've already connected."
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
            placeholder={tab === 'installed' ? 'Search connectors…' : 'Search providers…'}
          />
        }
        cta={
          <PrimaryButton variant="ink" href="/credentials">
            Manage credentials
          </PrimaryButton>
        }
      />

      <div className="pt-5">
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
            category={category}
            onCategoryChange={setCategory}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Maps a catalog slug to one of the ChipRow category labels.
 * Derived from the slug + authType — no extra column needed.
 */
export function catalogCategory(slug: string): string {
  if (slug.startsWith('google-') || slug === 'gmail') return 'Productivity';
  if (
    slug === 'notion' ||
    slug === 'notion-oauth' ||
    slug === 'airtable' ||
    slug === 'airtable-oauth'
  )
    return 'Productivity';
  if (slug === 'github') return 'DevTools';
  if (slug === 'linear') return 'DevTools';
  if (slug === 'hubspot') return 'CRM';
  if (slug === 'slack') return 'Comms';
  if (slug === 'intercom') return 'Comms';
  if (slug === 'apify' || slug === 'firecrawl' || slug === 'tavily') return 'Data';
  if (slug === 'stripe') return 'Data';
  if (slug === 'postgres') return 'Data';
  return 'Other';
}

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">
        No connectors installed yet.
        <br />
        Browse the Marketplace to add one.
      </p>
      <div className="mt-4 inline-flex">
        <PrimaryButton variant="blue" onClick={onBrowse}>
          Browse Marketplace
        </PrimaryButton>
      </div>
    </div>
  );
}

function EmptySearch() {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">No connectors match your search.</p>
    </div>
  );
}
