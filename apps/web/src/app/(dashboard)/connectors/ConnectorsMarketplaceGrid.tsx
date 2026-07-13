'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle } from '@phosphor-icons/react';
import type { ConnectorRow, ConnectorCatalogItem } from '@/lib/actions.ts';
import type { CompatibleCredential } from './ConnectorForm.tsx';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import ConnectorAddForm from './ConnectorAddForm.tsx';
import CredentialWizard, { type CredentialWizardType } from '../credentials/CredentialWizard.tsx';
import { CONN_BRAND_COLORS, connGlyph, connIcon } from './connector-brand.ts';
import { catalogCategory } from './categories.ts';

type Props = {
  catalog: ConnectorCatalogItem[];
  instances: ConnectorRow[];
  credsByType: Record<string, CompatibleCredential[]>;
};

/**
 * ConnectorsMarketplaceGrid — the design's `.chip-row` + `.mk2-grid` pattern.
 * Category filter chips + 4-col grid of MarketplaceCard per catalog entry.
 * Each card's CTA opens a Modal with ConnectorAddForm rendered directly inside.
 * The CredentialWizard is owned at card level to avoid nesting two z-50 portals.
 */
export default function ConnectorsMarketplaceGrid({ catalog, instances, credsByType }: Props) {
  // Render connectors alphabetically by label.
  const sortedCatalog = [...catalog].sort((a, b) => a.label.localeCompare(b.label));
  return catalog.length === 0 ? (
    <EmptyState title="No connectors in this category." />
  ) : (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
      {sortedCatalog.map((item) => {
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const router = useRouter();

  const brandColor = CONN_BRAND_COLORS[catalogItem.slug];
  const glyph = connGlyph(catalogItem.slug, catalogItem.label);
  const iconSrc = connIcon(catalogItem.slug);
  const cat = catalogCategory(catalogItem.slug);

  // For oauth2 connectors with no existing credentials, the CTA skips the
  // connect-modal and goes straight to the CredentialWizard.
  const needsWizard = catalogItem.authType === 'oauth2' && compatibleCredentials.length === 0;

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
          ) : (
            <span className="font-mono text-[11px] font-semibold tracking-[0.04em]">{glyph}</span>
          )
        }
        glyphVariant="conn"
        glyphBackground={iconSrc ? '#ffffff' : brandColor}
        name={catalogItem.label}
        description={catalogItem.docsHint}
        category={cat}
        topRight={
          isInstalled ? (
            <span className="inline-flex items-center gap-1 rounded-[6px] bg-ok-bg px-2 py-1 font-sans text-[12px] font-medium text-ok">
              <CheckCircle size={11} weight="regular" />
              {installedCount} installed
            </span>
          ) : undefined
        }
        foot={
          <MarketplaceCardActions
            ctaLabel={isInstalled ? 'Add account' : 'Install'}
            ctaVariant="blue"
            onCta={() => (needsWizard ? setWizardOpen(true) : setAddOpen(true))}
          />
        }
      />

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={isInstalled ? `Add account - ${catalogItem.label}` : `Install ${catalogItem.label}`}
        dismissable={false}
      >
        <ConnectorAddForm
          catalogItem={catalogItem}
          compatibleCredentials={compatibleCredentials}
          onDone={handleDone}
          onCancel={() => setAddOpen(false)}
          onCreateNew={() => {
            setAddOpen(false);
            setWizardOpen(true);
          }}
        />
      </Modal>

      {wizardOpen && catalogItem.credentialType && (
        <CredentialWizard
          initialType={catalogItem.credentialType as CredentialWizardType}
          returnToConnectorSlug={catalogItem.slug}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
