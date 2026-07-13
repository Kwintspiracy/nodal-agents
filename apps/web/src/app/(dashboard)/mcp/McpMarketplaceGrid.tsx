'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle } from '@phosphor-icons/react';
import type { McpServerInstance, McpCatalogItem } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import EmptyState from '@/components/ui/EmptyState';
import { connIcon, connEmoji } from '../connectors/connector-brand.ts';
import Modal from '@/components/ui/Modal';
import McpAddForm from './McpAddForm.tsx';
import { mcpCategory } from './categories.ts';

const MCP_BLUE = '#3565ff';

type Props = {
  catalog: McpCatalogItem[];
  instances: McpServerInstance[];
};

/**
 * McpMarketplaceGrid — the design's `.mk2-grid` pattern for MCP.
 * 4-col grid of MarketplaceCard per catalog entry. The category filter chips
 * now live in the page toolbar (McpClient), so the grid simply renders the
 * already-filtered catalog it is handed.
 */
export default function McpMarketplaceGrid({ catalog, instances }: Props) {
  // Render alphabetically by label, keeping the "custom" entries last.
  const sortedCatalog = [...catalog].sort((a, b) => {
    const ac = a.slug.startsWith('custom-');
    const bc = b.slug.startsWith('custom-');
    if (ac !== bc) return ac ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  return catalog.length === 0 ? (
    <EmptyState title="No servers in this category." />
  ) : (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
      {sortedCatalog.map((item) => {
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
  const router = useRouter();
  const glyph = catalogItem.label.slice(0, 2).toUpperCase();
  const iconSrc = connIcon(catalogItem.slug);
  const emoji = connEmoji(catalogItem.slug);
  const cat = mcpCategory(catalogItem.slug);
  const isPending = catalogItem.status === 'pending';

  function handleDone() {
    setAddOpen(false);
    router.refresh();
  }

  return (
    <>
      <MarketplaceCard
        glyph={
          iconSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconSrc} alt="" className="h-6 w-6 object-contain" />
          ) : emoji ? (
            <span className="text-[20px] leading-none">{emoji}</span>
          ) : (
            <span className="font-mono text-[11px] font-semibold tracking-[0.04em]">{glyph}</span>
          )
        }
        glyphVariant="conn"
        glyphBackground={iconSrc || emoji ? '#ffffff' : MCP_BLUE}
        name={catalogItem.label}
        description={catalogItem.description}
        category={cat}
        topRight={
          isInstalled || isPending ? (
            <span className="flex items-center gap-1.5">
              {isPending && (
                <span
                  className="inline-flex items-center rounded-[6px] bg-warn-bg px-2 py-1 font-sans text-[12px] font-medium text-warn"
                  title="Not yet verified end-to-end, connection params may need adjusting."
                >
                  Test pending
                </span>
              )}
              {isInstalled && (
                <span className="inline-flex items-center gap-1 rounded-[6px] bg-ok-bg px-2 py-1 font-sans text-[12px] font-medium text-ok">
                  <CheckCircle size={11} weight="regular" />
                  {installedCount} installed
                </span>
              )}
            </span>
          ) : undefined
        }
        foot={
          <MarketplaceCardActions
            ctaLabel={isInstalled ? 'Add account' : 'Install'}
            ctaVariant="blue"
            onCta={() => setAddOpen(true)}
          />
        }
      />

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={isInstalled ? `Add account - ${catalogItem.label}` : `Install ${catalogItem.label}`}
        dismissable={false}
      >
        <McpAddForm
          catalogItem={catalogItem}
          onDone={handleDone}
          onCancel={() => setAddOpen(false)}
        />
      </Modal>
    </>
  );
}
