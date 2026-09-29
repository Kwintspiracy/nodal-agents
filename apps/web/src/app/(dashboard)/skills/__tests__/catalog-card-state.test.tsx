// catalog-card-state.test.tsx — what a catalog card offers, for every state of
// the workspace skill holding its slug.
//
// Screen 8 refused by Quentin (29/09): "there is an Install button although
// they are already installed". comfy-debug and comfy-director had been written
// into the workspace by hand, with no source; the card only knew skills
// installed from the catalog, so it offered to install them again. The card
// now reads ANY workspace skill of its slug: absent, installed from the card's
// source, or there from elsewhere (by hand, another source), which it offers
// to replace, after a confirmation that says when the skill in place is
// another skill.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
const installCommunitySkillAction = vi.fn();
vi.mock('@/lib/actions.ts', () => ({
  installCommunitySkillAction: (...args: unknown[]) => installCommunitySkillAction(...args),
  previewCommunitySkillUpdateAction: vi.fn(),
  updateCommunitySkillAction: vi.fn(),
  acknowledgeSkillUpdateAction: vi.fn(),
}));

import CommunitySkillsGrid, {
  toCatalogCardSkills,
  type InstalledSkillInfo,
} from '../CommunitySkillsGrid.tsx';
import type { SkillRow } from '@/lib/actions.ts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  installCommunitySkillAction.mockReset();
  document.body.innerHTML = '';
});

const DEBUG_SOURCE = 'Comfy-Org/comfy-cli/comfy_cli/skills/comfy-debug';

function skill(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    slug: 'comfy-debug',
    name: 'Comfy Debug (official)',
    source: null,
    updateAvailable: false,
    updateDetail: null,
    hasScripts: false,
    ...overrides,
  };
}

/** The "Comfy Debug (official)" card, with `installed` as the workspace skills. */
function debugCard(installed: InstalledSkillInfo[]): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CommunitySkillsGrid installedSkills={installed} />));
  const card = container.querySelector('[data-testid^="marketplace-card-comfy-debug-official"]');
  if (!card) throw new Error('the Comfy Debug (official) card is not rendered');
  return card as HTMLElement;
}

function buttonNamed(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

describe('catalog card, for each state of the skill holding its slug @cap:apprendre-une-skill/ecran', () => {
  it('absent: the card offers Install', () => {
    const card = debugCard([skill({ slug: 'something-else', name: 'Other' })]);
    expect(buttonNamed(card, 'Install')).toBeDefined();
    expect(card.textContent).not.toContain('Installed');
    expect(card.textContent).not.toContain('not from catalog');
  });

  it('installed from the catalog, up to date: "Installed", no Install, no Replace', () => {
    const card = debugCard([skill({ source: DEBUG_SOURCE })]);
    expect(card.textContent).toContain('Installed');
    expect(buttonNamed(card, 'Install')).toBeUndefined();
    expect(buttonNamed(card, 'Replace')).toBeUndefined();
  });

  it.each([
    ['written by hand', null, 'written there by hand'],
    [
      'installed from another source',
      'https://github.com/someone/fork/tree/main/comfy-debug',
      'installed from https://github.com/someone/fork/tree/main/comfy-debug',
    ],
  ])('in the workspace, %s: never Install; says so and offers Replace', (_l, source, origin) => {
    const card = debugCard([skill({ source })]);
    expect(buttonNamed(card, 'Install')).toBeUndefined();
    expect(card.textContent).not.toContain('Installed');
    expect(card.textContent).toContain('In workspace, not from catalog');
    expect(
      card.querySelector(`[title="\\"Comfy Debug (official)\\" is in your workspace, ${origin}"]`),
    ).not.toBeNull();
    expect(buttonNamed(card, 'Replace')).toBeDefined();
  });

  it('Replace asks first, then installs from the card source with replace, never before', async () => {
    installCommunitySkillAction.mockResolvedValue({ ok: true, data: {} });
    const card = debugCard([skill({ source: null })]);

    act(() => buttonNamed(card, 'Replace')!.click());
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain('Replace with the catalog version?');
    expect(d!.textContent).toContain(
      '"Comfy Debug (official)" is already in your workspace, written by hand.',
    );
    expect(d!.textContent).toContain('Agents it is assigned to keep it.');
    expect(d!.textContent).toContain('Updates will then come from Comfy-Org/comfy-cli.');
    expect(d!.textContent).not.toContain('another skill');
    expect(installCommunitySkillAction).not.toHaveBeenCalled();

    await act(async () => buttonNamed(d!, 'Replace')!.click());
    expect(installCommunitySkillAction.mock.calls).toEqual([[DEBUG_SOURCE, { replace: true }]]);
    // Replaced: the card now reads as installed from the catalog.
    expect(card.textContent).toContain('Installed');
    expect(buttonNamed(card, 'Replace')).toBeUndefined();
  });

  it('a skill in place under another name: the confirmation says it is another skill', () => {
    const card = debugCard([skill({ name: 'My error notes', source: null })]);
    act(() => buttonNamed(card, 'Replace')!.click());
    const d = dialog();
    expect(d!.textContent).toContain('Replace a different skill?');
    expect(d!.textContent).toContain(
      'The slug "comfy-debug" is taken by another skill in your workspace: "My error notes", written by hand.',
    );
    expect(d!.textContent).toContain('deletes its text for good');
    expect(buttonNamed(d!, 'Replace it')).toBeDefined();
  });

  it('the workspace rows the page hands the grid include a hand-written skill (the rows of screen 8)', () => {
    // The row as the database holds it on Quentin's workspace: no source,
    // is_community false.
    const handWritten = {
      id: 'id-comfy-debug',
      name: 'Comfy Debug (official)',
      slug: 'comfy-debug',
      isSystem: false,
      systemKind: null,
      content: 'copied by hand',
      defaultContent: 'copied by hand',
      contentOverridden: false,
      description: null,
      active: true,
      requiredBuiltins: [],
      createdBy: 'user',
      isCommunity: false,
      source: null,
      installedScripts: null,
      updateAvailable: false,
      updateDetail: null,
      scriptsAuthorized: null,
      filesWritable: null,
      assignmentCount: 1,
      assignedAgents: [],
      createdAt: null,
      updatedAt: null,
    } as unknown as SkillRow;
    const card = debugCard(toCatalogCardSkills([handWritten]));
    expect(buttonNamed(card, 'Install')).toBeUndefined();
    expect(card.textContent).toContain('In workspace, not from catalog');
  });

  it('a plain Install does not ask to replace', async () => {
    installCommunitySkillAction.mockResolvedValue({ ok: true, data: {} });
    const card = debugCard([]);
    await act(async () => buttonNamed(card, 'Install')!.click());
    expect(dialog()).toBeNull();
    expect(installCommunitySkillAction.mock.calls).toEqual([[DEBUG_SOURCE, { replace: false }]]);
  });
});
