// catalog-card-installed.test.tsx — a catalog card is installed when its slug
// is in the workspace, whatever the skill's origin.
//
// Screen 8 refused by Quentin (29/09): "there is an Install button although
// they are already installed". comfy-debug and comfy-director were in the
// workspace with no source and is_community = false; the page handed the
// catalog only its community skills, so the cards offered Install. Quentin's
// rule: a skill is installed or it is not, there is nothing in between.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/actions.ts', () => ({
  installCommunitySkillAction: vi.fn(),
  previewCommunitySkillUpdateAction: vi.fn(),
  updateCommunitySkillAction: vi.fn(),
  acknowledgeSkillUpdateAction: vi.fn(),
}));

import CommunitySkillsGrid, { toCatalogCardSkills } from '../CommunitySkillsGrid.tsx';
import type { SkillRow } from '@/lib/actions.ts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** A workspace row as the database holds it. */
function row(slug: string, origin: { isCommunity: boolean; source: string | null }): SkillRow {
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
    installedScripts: null,
    updateAvailable: false,
    updateDetail: null,
    scriptsAuthorized: null,
    filesWritable: null,
    assignmentCount: 1,
    assignedAgents: [],
    createdAt: null,
    updatedAt: null,
    ...origin,
  } as SkillRow;
}

/** The "Comfy Debug (official)" card, for these workspace rows. */
function debugCard(rows: SkillRow[]): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CommunitySkillsGrid installedSkills={toCatalogCardSkills(rows)} />));
  const card = container.querySelector('[data-testid^="marketplace-card-comfy-debug-official"]');
  if (!card) throw new Error('the Comfy Debug (official) card is not rendered');
  return card as HTMLElement;
}

function hasButton(scope: ParentNode, label: string): boolean {
  return [...scope.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
}

describe('catalog card, installed = its slug is in the workspace @cap:apprendre-une-skill/ecran', () => {
  it.each([
    ['with no source (the rows of screen 8)', { isCommunity: false, source: null }],
    [
      'installed from the catalog',
      { isCommunity: true, source: 'Comfy-Org/comfy-cli/comfy_cli/skills/comfy-debug' },
    ],
    [
      'installed from another source',
      { isCommunity: true, source: 'https://github.com/someone/fork/tree/main/comfy-debug' },
    ],
  ])('slug present, %s: "Installed", no Install', (_label, origin) => {
    const card = debugCard([row('comfy-debug', origin)]);
    expect(card.textContent).toContain('Installed');
    expect(hasButton(card, 'Install')).toBe(false);
  });

  it('slug absent: Install', () => {
    const card = debugCard([row('something-else', { isCommunity: false, source: null })]);
    expect(hasButton(card, 'Install')).toBe(true);
    expect(card.textContent).not.toContain('Installed');
  });
});
