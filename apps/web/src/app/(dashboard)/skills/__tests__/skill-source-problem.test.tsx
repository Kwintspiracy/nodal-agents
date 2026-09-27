// skill-source-problem.test.tsx — what the owner SEES when the last update
// check could not read an installed community skill's source as this skill.
//
// Codex, PR #548 pass 3: the runner used to write the same row as a healthy
// "no update" in that case, so the catalog card said "Installed" and the
// workspace table showed nothing — a pending badge vanished into a false
// green. The runner now records a code (update_detail.sourceProblem); these
// cases prove both screens word it as a warning, for each code, and that the
// ordinary states still render as before.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/actions.ts', () => ({
  installCommunitySkillAction: vi.fn(),
  deleteSkillAction: vi.fn(),
  uninstallCommunitySkillAction: vi.fn(),
  previewCommunitySkillUpdateAction: vi.fn(),
  updateCommunitySkillAction: vi.fn(),
  acknowledgeSkillUpdateAction: vi.fn(),
  assignSkillAction: vi.fn(),
  unassignSkillAction: vi.fn(),
  createSkillAction: vi.fn(),
  updateSkillAction: vi.fn(),
  resetSkillToDefaultAction: vi.fn(),
}));

import CommunitySkillsGrid, { type InstalledSkillInfo } from '../CommunitySkillsGrid.tsx';
import SkillsAssignedTable from '../SkillsAssignedTable.tsx';
import type { SkillRow, SkillUpdateDetail } from '@/lib/actions.ts';
import { segmentSkillsByProvenance } from '@/lib/skill-provenance.ts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const CHECKED_AT = '2026-09-28T00:00:00.000Z';
const IDENTITY: SkillUpdateDetail = {
  sourceProblem: 'identity_changed',
  upstreamSlug: 'other-skill',
  checkedAt: CHECKED_AT,
};
const NOT_FOUND: SkillUpdateDetail = { sourceProblem: 'source_not_found', checkedAt: CHECKED_AT };
const UP_TO_DATE: SkillUpdateDetail = {
  contentChanged: false,
  scriptsChanged: false,
  scriptsState: 'clean',
  checkedAt: CHECKED_AT,
};
const PENDING: SkillUpdateDetail = {
  contentChanged: true,
  scriptsChanged: false,
  scriptsState: 'clean',
  checkedAt: CHECKED_AT,
};

/** The footer of the "Comfy (official)" catalog card, for one installed state. */
function comfyCardFoot(updateAvailable: boolean, updateDetail: SkillUpdateDetail | null) {
  const installed: InstalledSkillInfo[] = [
    { slug: 'comfy', updateAvailable, updateDetail, hasScripts: false },
  ];
  const el = render(<CommunitySkillsGrid installedSkills={installed} />);
  const card = el.querySelector('[data-testid^="marketplace-card-comfy-official"]');
  if (!card) throw new Error('the Comfy (official) card is not rendered');
  return card as HTMLElement;
}

describe('catalog card, installed skill whose source has a problem @cap:apprendre-une-skill/ecran', () => {
  it('identity_changed: the card warns, names the skill the source serves now, and offers no update', () => {
    const card = comfyCardFoot(false, IDENTITY);
    expect(card.textContent).toContain('Source serves another skill');
    expect(card.querySelector('[title*="other-skill"]')).not.toBeNull();
    expect(card.textContent).not.toContain('Update available');
    // The host badge makes room for the warning.
    expect(card.querySelector('[title="Comfy-Org/comfy-cli"]')).toBeNull();
  });

  it('source_not_found: the card warns that the source is gone', () => {
    const card = comfyCardFoot(false, NOT_FOUND);
    expect(card.textContent).toContain('Source not found');
    expect(card.textContent).not.toContain('Update available');
    expect(card.querySelector('[title="Comfy-Org/comfy-cli"]')).toBeNull();
  });

  it('ordinary states are unchanged: up to date shows the host and "Installed", a pending update its badge', () => {
    const healthy = comfyCardFoot(false, UP_TO_DATE);
    expect(healthy.textContent).toContain('Installed');
    expect(healthy.querySelector('[title="Comfy-Org/comfy-cli"]')?.textContent).toBe('github');
    expect(healthy.textContent).not.toContain('Source');
    act(() => root?.unmount());
    container?.remove();

    const pending = comfyCardFoot(true, PENDING);
    expect(pending.textContent).toContain('Update available');
    expect(pending.textContent).not.toContain('Source');
  });
});

function communityRow(
  slug: string,
  updateAvailable: boolean,
  updateDetail: SkillUpdateDetail | null,
): SkillRow {
  return {
    id: `id-${slug}`,
    name: `Skill ${slug}`,
    slug,
    isSystem: false,
    systemKind: null,
    content: 'Do the thing.',
    defaultContent: 'Do the thing.',
    contentOverridden: false,
    description: null,
    active: true,
    requiredBuiltins: [],
    createdBy: 'user',
    isCommunity: true,
    source: `owner/${slug}`,
    installedScripts: null,
    updateAvailable,
    updateDetail,
    scriptsAuthorized: null,
    filesWritable: null,
    assignmentCount: 0,
    assignedAgents: [],
    createdAt: null,
    updatedAt: null,
  } as SkillRow;
}

/** The table row whose title cell names `name`. */
function rowNamed(el: HTMLElement, name: string): HTMLElement {
  const row = [...el.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('workspace table, installed skill whose source has a problem @cap:apprendre-une-skill/ecran', () => {
  it('shows a warning per problem code, the update badge for a pending update, and nothing for an up-to-date skill', () => {
    const rows = [
      communityRow('renamed', false, IDENTITY),
      communityRow('gone', false, NOT_FOUND),
      communityRow('pending', true, PENDING),
      communityRow('healthy', false, UP_TO_DATE),
    ];
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance(rows)} agents={[]} />,
    );

    const renamed = rowNamed(el, 'Skill renamed');
    expect(renamed.textContent).toContain('Source serves another skill');
    expect(renamed.querySelector('[title*="other-skill"]')).not.toBeNull();
    expect(renamed.textContent).not.toContain('Update available');
    // Nothing to apply: no update action on the row.
    expect(renamed.querySelector('[title^="Update available"]')).toBeNull();

    const gone = rowNamed(el, 'Skill gone');
    expect(gone.textContent).toContain('Source not found');
    expect(gone.querySelector('[title^="Update available"]')).toBeNull();

    const pending = rowNamed(el, 'Skill pending');
    expect(pending.textContent).toContain('Update available');
    expect(pending.textContent).not.toContain('Source');

    const healthy = rowNamed(el, 'Skill healthy');
    expect(healthy.textContent).not.toContain('Update available');
    expect(healthy.textContent).not.toContain('Source');
  });
});
