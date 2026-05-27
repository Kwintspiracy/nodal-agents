'use client';

import { useState } from 'react';
import { CheckCircle, Gear, Plus } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import ChipRow, { type ChipItem } from '@/components/ui/ChipRow';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import PrimaryButton from '@/components/ui/PrimaryButton';
import IconButton from '@/components/ui/IconButton';
import McpAddForm from './McpAddForm.tsx';
import { mcpCategory } from './McpClient.tsx';

const MCP_BLUE = '#3565ff';

const CATEGORIES: ChipItem<string>[] = [
  { value: 'All', label: 'All' },
  { value: 'Comms', label: 'Comms' },
  { value: 'Data', label: 'Data' },
  { value: 'Productivity', label: 'Productivity' },
  { value: 'Custom', label: 'Custom' },
  { value: 'Other', label: 'Other' },
];

type Props = {
  catalog: McpCatalogItem[];
  instances: McpServerInstance[];
  category: string;
  onCategoryChange: (cat: string) => void;
};

/**
 * McpMarketplaceGrid — the design's `.chip-row` + `.mk2-grid` pattern for MCP.
 * Category filter chips + 4-col grid of MarketplaceCard per catalog entry.
 */
export default function McpMarketplaceGrid({
  catalog,
  instances,
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
          <p className="text-[13px] text-ink-3">No servers in this category.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
          {catalog.map((item) => {
            const installedInstances = instances.filter((i) => i.slug === item.slug);
            const isInstalled = installedInstances.length > 0;
            return (
              <McpMarketCard
                key={item.slug}
                catalogItem={item}
                isInstalled={isInstalled}
                installedCount={installedInstances.length}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function McpMarketCard({
  catalogItem,
  isInstalled,
  installedCount,
}: {
  catalogItem: McpCatalogItem;
  isInstalled: boolean;
  installedCount: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const glyph = catalogItem.label.slice(0, 2).toUpperCase();
  const cat = mcpCategory(catalogItem.slug);

  return (
    <div className="flex flex-col">
      <MarketplaceCard
        glyph={
          <span className="font-mono text-[10px] font-semibold tracking-[0.04em]">{glyph}</span>
        }
        glyphVariant="conn"
        glyphBackground={MCP_BLUE}
        name={catalogItem.label}
        description={catalogItem.description}
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
          <>
            <span className="flex-1 text-[12.5px] leading-none text-ink-3">
              {isInstalled ? `${installedCount} instance${installedCount !== 1 ? 's' : ''}` : ''}
            </span>
            <PrimaryButton variant="coral" size="sm" onClick={() => setAddOpen((v) => !v)}>
              <Plus size={12} weight="bold" />
              {isInstalled ? '+ Add account' : '+ Install'}
            </PrimaryButton>
            {isInstalled && (
              <IconButton size="sm" aria-label="Settings" onClick={() => setAddOpen((v) => !v)}>
                <Gear size={13} />
              </IconButton>
            )}
          </>
        }
      />

      {/* Inline McpAddForm — expands below the card */}
      {addOpen && (
        <div className="mt-1.5 rounded-2xl border border-rule-2 bg-paper p-4">
          <McpAddForm catalogItem={catalogItem} />
        </div>
      )}
    </div>
  );
}
