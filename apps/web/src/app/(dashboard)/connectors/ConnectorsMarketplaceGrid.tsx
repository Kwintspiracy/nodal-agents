'use client';

import { CheckCircle } from '@phosphor-icons/react';
import type { ConnectorRow, ConnectorCatalogItem } from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import ChipRow, { type ChipItem } from '@/components/ui/ChipRow';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import ConnectorAddForm from './ConnectorAddForm.tsx';
import { CONN_BRAND_COLORS, connGlyph } from './connector-brand.ts';
import { catalogCategory } from './categories.ts';
import { useState } from 'react';

const CATEGORIES: ChipItem<string>[] = [
  { value: 'All', label: 'All' },
  { value: 'CRM', label: 'CRM' },
  { value: 'Productivity', label: 'Productivity' },
  { value: 'Data', label: 'Data' },
  { value: 'DevTools', label: 'DevTools' },
  { value: 'Comms', label: 'Comms' },
  { value: 'Other', label: 'Other' },
];

type Props = {
  catalog: ConnectorCatalogItem[];
  instances: ConnectorRow[];
  credsByType: Record<string, CompatibleCredential[]>;
  category: string;
  onCategoryChange: (cat: string) => void;
};

/**
 * ConnectorsMarketplaceGrid — the design's `.chip-row` + `.mk2-grid` pattern.
 * Category filter chips + 4-col grid of MarketplaceCard per catalog entry.
 * Each card's CTA expands a ConnectorAddForm inline.
 */
export default function ConnectorsMarketplaceGrid({
  catalog,
  instances,
  credsByType,
  category,
  onCategoryChange,
}: Props) {
  return (
    <div>
      <ChipRow
        items={CATEGORIES}
        value={category}
        onChange={onCategoryChange}
        className="mb-[18px]"
      />

      {catalog.length === 0 ? (
        <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
          <p className="text-[13px] text-ink-3">No connectors in this category.</p>
        </div>
      ) : (
        <div className="grid auto-rows-fr grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
          {catalog.map((item) => {
            const installedInstances = instances.filter((i) => i.slug === item.slug);
            const isInstalled = installedInstances.length > 0;
            const compatible = item.credentialType ? (credsByType[item.credentialType] ?? []) : [];
            return (
              <ConnectorMarketCard
                key={item.slug}
                catalogItem={item}
                isInstalled={isInstalled}
                installedCount={installedInstances.length}
                compatibleCredentials={compatible}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectorMarketCard({
  catalogItem,
  isInstalled,
  installedCount,
  compatibleCredentials,
}: {
  catalogItem: ConnectorCatalogItem;
  isInstalled: boolean;
  installedCount: number;
  compatibleCredentials: CompatibleCredential[];
}) {
  const [addOpen, setAddOpen] = useState(false);

  const brandColor = CONN_BRAND_COLORS[catalogItem.slug];
  const glyph = connGlyph(catalogItem.slug, catalogItem.label);
  const cat = catalogCategory(catalogItem.slug);

  return (
    <div className="flex flex-col">
      <MarketplaceCard
        glyph={
          <span className="font-mono text-[10px] font-semibold tracking-[0.04em]">{glyph}</span>
        }
        glyphVariant="conn"
        glyphBackground={brandColor}
        name={catalogItem.label}
        description={catalogItem.docsHint}
        category={cat}
        topRight={
          isInstalled ? (
            <span className="inline-flex items-center gap-1 rounded-[6px] bg-ok-bg px-2 py-1 font-sans text-[11px] font-medium text-ok">
              <CheckCircle size={11} weight="regular" />
              {installedCount} installed
            </span>
          ) : undefined
        }
        foot={
          <MarketplaceCardActions
            ctaLabel={isInstalled ? 'Add account' : 'Install'}
            ctaVariant="blue"
            onCta={() => setAddOpen((v) => !v)}
          />
        }
      />

      {/* Inline ConnectorAddForm — expands below the card */}
      {addOpen && (
        <div className="mt-1.5 rounded-2xl border border-rule-2 bg-paper p-4">
          <ConnectorAddForm
            catalogItem={catalogItem}
            compatibleCredentials={compatibleCredentials}
          />
        </div>
      )}
    </div>
  );
}
