'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DownloadSimple, ArrowClockwise, ArrowsLeftRight } from '@phosphor-icons/react';
import { COMMUNITY_SKILL_CATALOG, type CommunitySkillCatalogEntry } from '@nodal-agents/shared';
import {
  installCommunitySkillAction,
  type SkillRow,
  type SkillUpdateDetail,
} from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import StatusPill from '@/components/ui/StatusPill';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import SkillUpdateAction from './SkillUpdateAction.tsx';
import SkillSourceProblemPill from './SkillSourceProblemPill.tsx';

/** One skill of the workspace, keyed by slug: just enough to say what a
 *  catalog card of that slug is (see catalogCardState) and to drive the
 *  "Update available" badge/CTA, without pulling in the full SkillRow. */
export type InstalledSkillInfo = {
  slug: string;
  /** The name the workspace shows for it. */
  name: string;
  /** Where it was installed from; null when it was written in the workspace. */
  source: string | null;
  updateAvailable: boolean;
  updateDetail: SkillUpdateDetail | null;
  /** True when the skill bundles any scripts — drives the unconditional
   *  revocation warning in the update confirm dialog. */
  hasScripts: boolean;
};

/** The workspace skills a catalog card reads: EVERY one, not only the
 *  community ones. A card whose slug a hand-written skill already holds must
 *  not offer a fresh install (screen 8, 29/09). */
export function toCatalogCardSkills(skills: SkillRow[]): InstalledSkillInfo[] {
  return skills.map((s) => ({
    slug: s.slug,
    name: s.name,
    source: s.source,
    updateAvailable: s.updateAvailable,
    updateDetail: s.updateDetail,
    hasScripts: Boolean(s.installedScripts && s.installedScripts.length > 0),
  }));
}

type Props = {
  /** EVERY skill of this workspace, wherever it came from: a card whose slug
   *  is taken is never offered as a fresh install (catalogCardState). */
  installedSkills: InstalledSkillInfo[];
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
 * What a catalog card is for this workspace. ONE rule for every card: the
 * workspace skill holding the card's slug, if any, and whether it came from
 * the card's source.
 *   - absent: nothing holds the slug, the card offers Install.
 *   - from-catalog: installed from this source, so tracked for updates.
 *   - elsewhere: the slug is taken by a skill written in the workspace or
 *     installed from another source. Installing would not add a skill: the
 *     card offers to replace that one, which keeps its assignments.
 * `sameName` is the one clue the card has that the skill in place is this
 * one: a skill in place under another name is said to be another skill.
 */
export type CatalogCardState =
  | { kind: 'absent' }
  | { kind: 'from-catalog'; skill: InstalledSkillInfo | null }
  | { kind: 'elsewhere'; skill: InstalledSkillInfo; sameName: boolean };

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function catalogCardState(
  entry: CommunitySkillCatalogEntry,
  skill: InstalledSkillInfo | null,
): CatalogCardState {
  if (!skill) return { kind: 'absent' };
  if (skill.source === entry.source) return { kind: 'from-catalog', skill };
  return {
    kind: 'elsewhere',
    skill,
    sameName: normalizedName(skill.name) === normalizedName(entry.name),
  };
}

/**
 * CommunitySkillsGrid — the curated community-skill catalog as a card grid.
 * Each card installs from its known source with ONE click; the button names the
 * source explicitly ("Install from GitHub"). Already-installed entries show a
 * muted "Installed" instead; a slug held by a skill from elsewhere offers to
 * replace it (catalogCardState).
 */
export default function CommunitySkillsGrid({
  installedSkills,
  query = '',
  category = 'All',
}: Props) {
  const installedMap = new Map(installedSkills.map((s) => [s.slug, s]));
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
          installed={installedMap.get(entry.slug) ?? null}
        />
      ))}
    </div>
  );
}

function CommunitySkillCard({
  entry,
  installed,
}: {
  entry: CommunitySkillCatalogEntry;
  installed: InstalledSkillInfo | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic flip right after an install or a replace: both leave the card
  // installed from the catalog, with no pending update.
  const [justInstalled, setJustInstalled] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const state: CatalogCardState = justInstalled
    ? { kind: 'from-catalog', skill: null }
    : catalogCardState(entry, installed);

  function install(replace: boolean) {
    startTransition(async () => {
      const result = await installCommunitySkillAction(entry.source, { replace });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setJustInstalled(true);
      toast.success(
        replace
          ? `${entry.name} replaced with the catalog version`
          : `${entry.name} installed — assign it to an agent`,
      );
      router.refresh();
    });
  }

  // Footer shows just the host ("github"); the full owner/repo is on hover.
  const badge = (
    <span className="cursor-help text-mono-12 text-ink-4" title={repoOf(entry.source)}>
      {hostLabel(entry.sourceHost).toLowerCase()}
    </span>
  );

  return (
    <MarketplaceCard
      name={entry.name}
      description={entry.description}
      category={entry.category}
      foot={
        state.kind === 'from-catalog' ? (
          <InstalledFoot entry={entry} installed={state.skill} badge={badge} />
        ) : state.kind === 'elsewhere' ? (
          <>
            <MarketplaceCardActions
              status={
                <span title={elsewhereTitle(state.skill)}>
                  <StatusPill variant="idle" label="In workspace, not from catalog" />
                </span>
              }
              ctaLabel={isPending ? 'Replacing…' : 'Replace'}
              ctaVariant="coral"
              icon={<ArrowsLeftRight size={12} weight="bold" />}
              onCta={isPending ? undefined : () => setConfirmReplace(true)}
            />
            <ConfirmDialog
              open={confirmReplace}
              {...replaceConfirmation(entry, state)}
              onConfirm={() => {
                setConfirmReplace(false);
                install(true);
              }}
              onCancel={() => setConfirmReplace(false)}
            />
          </>
        ) : (
          <MarketplaceCardActions
            status={badge}
            ctaLabel={isPending ? 'Installing…' : 'Install'}
            ctaVariant="coral"
            icon={<DownloadSimple size={12} weight="bold" />}
            onCta={isPending ? undefined : () => install(false)}
          />
        )
      }
    />
  );
}

/** Where the skill in place came from, for the pill's hover text. */
function elsewhereTitle(skill: InstalledSkillInfo): string {
  return skill.source
    ? `"${skill.name}" is in your workspace, installed from ${skill.source}`
    : `"${skill.name}" is in your workspace, written there by hand`;
}

/** The replace confirmation. A skill in place under another name is said to be
 *  another skill: replacing it loses that skill, not an older copy of this one. */
function replaceConfirmation(
  entry: CommunitySkillCatalogEntry,
  state: Extract<CatalogCardState, { kind: 'elsewhere' }>,
): { title: string; message: string; confirmLabel: string } {
  const origin = state.skill.source ? `installed from ${state.skill.source}` : 'written by hand';
  const kept = 'Agents it is assigned to keep it.';
  const tracked = `Updates will then come from ${repoOf(entry.source)}.`;
  if (state.sameName) {
    return {
      title: 'Replace with the catalog version?',
      message:
        `"${state.skill.name}" is already in your workspace, ${origin}. ` +
        `Its text will be replaced by the catalog version. ${kept} ${tracked}`,
      confirmLabel: 'Replace',
    };
  }
  return {
    title: 'Replace a different skill?',
    message:
      `The slug "${entry.slug}" is taken by another skill in your workspace: ` +
      `"${state.skill.name}", ${origin}. Replacing it deletes its text for good and puts ` +
      `"${entry.name}" in its place. ${kept} ${tracked}`,
    confirmLabel: 'Replace it',
  };
}

/** Footer of a card installed from the catalog: its update or source state. */
function InstalledFoot({
  entry,
  installed,
  badge,
}: {
  entry: CommunitySkillCatalogEntry;
  installed: InstalledSkillInfo | null;
  badge: ReactNode;
}) {
  if (installed?.updateAvailable) {
    return (
      <SkillUpdateAction
        slug={entry.slug}
        name={entry.name}
        updateDetail={installed.updateDetail}
        hasScripts={installed.hasScripts}
      >
        {({ onClick, pending }) => (
          <MarketplaceCardActions
            status={
              <StatusPill
                variant="warn"
                label={
                  installed.updateDetail?.scriptsState === 'conflict'
                    ? 'Update conflicts with your edits'
                    : 'Update available'
                }
              />
            }
            ctaLabel={pending ? 'Updating…' : 'Update'}
            ctaVariant="coral"
            icon={<ArrowClockwise size={12} weight="bold" />}
            onCta={pending ? undefined : onClick}
          />
        )}
      </SkillUpdateAction>
    );
  }
  return (
    <>
      {/* A source that no longer holds this skill is not a healthy
          install: the warning takes the host badge's place. */}
      <span className="min-w-0 flex-1 truncate">
        {installed?.updateDetail?.sourceProblem ? (
          <SkillSourceProblemPill detail={installed.updateDetail} />
        ) : (
          badge
        )}
      </span>
      <span className="inline-flex h-[30px] shrink-0 items-center rounded-[7px] border border-rule bg-paper px-3 text-medium-13 text-ink-4">
        Installed
      </span>
    </>
  );
}
