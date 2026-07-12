'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DownloadSimple } from '@phosphor-icons/react';
import { COMMUNITY_SKILL_CATALOG, type CommunitySkillCatalogEntry } from '@nodal-agents/shared';
import { installCommunitySkillAction } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import EmptyState from '@/components/ui/EmptyState';

type Props = {
  /** Slugs already installed in this workspace — drives the "Installed" state. */
  installedSlugs: string[];
  /** Optional search query — filters by name/description/category. */
  query?: string;
  /** Content-category filter ("All" = no filter). */
  category?: string;
};

/** Human label for the install button: github → "GitHub", skills-sh → "Skills.sh". */
function hostLabel(host: CommunitySkillCatalogEntry['sourceHost']): string {
  return host === 'skills-sh' ? 'Skills.sh' : 'GitHub';
}

/** "owner/repo" prefix of the source, for the foot badge. */
function repoOf(source: string): string {
  return source.split('/').slice(0, 2).join('/');
}

/**
 * CommunitySkillsGrid — the curated community-skill catalog as a card grid.
 * Each card installs from its known source with ONE click; the button names the
 * source explicitly ("Install from GitHub"). Already-installed entries show a
 * muted "Installed" instead.
 */
export default function CommunitySkillsGrid({
  installedSlugs,
  query = '',
  category = 'All',
}: Props) {
  const installed = new Set(installedSlugs);
  const q = query.trim().toLowerCase();
  let entries = COMMUNITY_SKILL_CATALOG;
  if (category !== 'All') entries = entries.filter((e) => e.category === category);
  if (q)
    entries = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q),
    );

  if (entries.length === 0) {
    return <EmptyState title="No community skills match your search." />;
  }

  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => (
        <CommunitySkillCard
          key={entry.slug}
          entry={entry}
          isInstalled={installed.has(entry.slug)}
        />
      ))}
    </div>
  );
}

function CommunitySkillCard({
  entry,
  isInstalled,
}: {
  entry: CommunitySkillCatalogEntry;
  isInstalled: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [installed, setInstalled] = useState(isInstalled);

  function handleInstall() {
    startTransition(async () => {
      const result = await installCommunitySkillAction(entry.source);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setInstalled(true);
      toast.success(`${entry.name} installed — assign it to an agent`);
      router.refresh();
    });
  }

  // Footer shows just the host ("github"); the full owner/repo is on hover.
  const badge = (
    <span className="cursor-help font-mono text-[12px] text-ink-4" title={repoOf(entry.source)}>
      {hostLabel(entry.sourceHost).toLowerCase()}
    </span>
  );

  return (
    <MarketplaceCard
      name={entry.name}
      description={entry.description}
      category={entry.category}
      foot={
        installed ? (
          <>
            <span className="min-w-0 flex-1 truncate">{badge}</span>
            <span className="inline-flex h-[30px] shrink-0 items-center rounded-[7px] border border-rule bg-paper px-3 text-[13px] font-medium text-ink-4">
              Installed
            </span>
          </>
        ) : (
          <MarketplaceCardActions
            status={badge}
            ctaLabel={isPending ? 'Installing…' : 'Install'}
            ctaVariant="coral"
            icon={<DownloadSimple size={12} weight="bold" />}
            onCta={isPending ? undefined : handleInstall}
          />
        )
      }
    />
  );
}
