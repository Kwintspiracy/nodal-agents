// skill-update-edited.test.tsx — what the owner of an EDITED skill sees when
// a newer version exists, whatever the skill's origin.
//
// Before: an edited system skill never showed a badge (the seeder only moved
// default_content), and an edited community skill's Update kept the owner's
// text — the badge cleared and they stayed on their own version for good. Now
// the badge shows for every origin, and Update on an edited skill opens a
// confirmation that says it replaces their changes and shows their text with
// a Copy button. These cases prove the dialog, both origins, and that Cancel
// changes nothing.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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

import * as actions from '@/lib/actions.ts';
import SkillsAssignedTable from '../SkillsAssignedTable.tsx';
import SkillForm from '../SkillForm.tsx';
import { EDITED_SKILL_UPDATE_MESSAGE } from '../SkillUpdateAction.tsx';
import type { SkillRow, SkillUpdateDetail } from '@/lib/actions.ts';
import { segmentSkillsByProvenance } from '@/lib/skill-provenance.ts';

const resetMock = vi.mocked(actions.resetSkillToDefaultAction);
const previewMock = vi.mocked(actions.previewCommunitySkillUpdateAction);
const updateMock = vi.mocked(actions.updateCommunitySkillAction);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

beforeEach(() => {
  resetMock.mockReset();
  previewMock.mockReset();
  updateMock.mockReset();
  resetMock.mockResolvedValue({ ok: true, data: undefined });
  updateMock.mockResolvedValue({
    ok: true,
    data: { contentChanged: true, scriptsChanged: false, scriptsAuthorizationRevoked: 0 },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const PENDING: SkillUpdateDetail = {
  contentChanged: true,
  scriptsChanged: false,
  checkedAt: '2026-10-31T00:00:00.000Z',
};

const MY_TEXT = 'MY OWN FOLDERS: D:/notes, D:/archive';

function skillRow(over: Partial<SkillRow>): SkillRow {
  return {
    id: 'id-x',
    name: 'Skill x',
    slug: 'x',
    isSystem: false,
    systemKind: null,
    content: 'Catalog text v1',
    defaultContent: 'Catalog text v1',
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
    assignmentCount: 0,
    assignedAgents: [],
    createdAt: null,
    updatedAt: null,
    ...over,
  } as SkillRow;
}

/** An edited system skill whose catalog text changed since (seeder flag). */
const editedSystem = skillRow({
  id: 'id-sys',
  name: 'Obsidian',
  slug: 'obsidian',
  isSystem: true,
  systemKind: 'capability',
  createdBy: 'system',
  content: MY_TEXT,
  defaultContent: 'Catalog text v2',
  contentOverridden: true,
  updateAvailable: true,
  updateDetail: PENDING,
});

/** An edited community skill whose source moved (check flag). */
const editedCommunity = skillRow({
  id: 'id-com',
  name: 'Comfy',
  slug: 'comfy',
  isCommunity: true,
  source: 'owner/comfy',
  content: MY_TEXT,
  defaultContent: 'Upstream v1',
  contentOverridden: true,
  updateAvailable: true,
  updateDetail: PENDING,
});

function rowNamed(el: HTMLElement, name: string): HTMLElement {
  const row = [...el.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function dialogButton(label: string): HTMLButtonElement {
  const d = dialog();
  if (!d) throw new Error('no dialog open');
  const b = [...d.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no "${label}" button in the dialog`);
  return b as HTMLButtonElement;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('update of an edited skill, whatever its origin @cap:apprendre-une-skill/ecran', () => {
  it('an edited SYSTEM skill shows "Update available" in the list (no longer community-only)', () => {
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([editedSystem])} agents={[]} />,
    );
    const row = rowNamed(el, 'Obsidian');
    expect(row.textContent).toContain('Update available');
    expect(row.querySelector('[title="Update available (replaces your changes)"]')).not.toBeNull();
  });

  it('Update on an edited system skill: the dialog warns, shows the text to copy, and confirm installs the new version', async () => {
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([editedSystem])} agents={[]} />,
    );
    await click(rowNamed(el, 'Obsidian').querySelector('[title^="Update available"]')!);

    const d = dialog();
    expect(d, 'no confirmation opened').not.toBeNull();
    expect(d!.textContent).toContain('Update this skill?');
    expect(d!.textContent).toContain(EDITED_SKILL_UPDATE_MESSAGE);
    const text = d!.querySelector('[data-testid="edited-skill-text"]');
    expect(text?.querySelector('pre')?.textContent).toBe(MY_TEXT);
    expect(text?.textContent).toContain('Copy');
    // A system skill's new version is local: nothing is fetched from a source.
    expect(previewMock).not.toHaveBeenCalled();

    await click(dialogButton('Update'));
    expect(resetMock.mock.calls).toEqual([['id-sys']]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('Cancel changes nothing: no apply is sent and the dialog closes', async () => {
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([editedSystem])} agents={[]} />,
    );
    await click(rowNamed(el, 'Obsidian').querySelector('[title^="Update available"]')!);
    await click(dialogButton('Cancel'));
    expect(dialog()).toBeNull();
    expect(resetMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('an edited COMMUNITY skill: the same warning and text, plus the reviewed diff; confirm sends the reviewed hash', async () => {
    previewMock.mockResolvedValue({
      ok: true,
      data: {
        currentContent: 'Upstream v1',
        upstreamContent: 'Upstream v2',
        contentChanged: true,
        scriptsChanged: false,
        scriptNames: [],
        upstreamContentHash: 'hash-of-v2',
        contentOverridden: true,
      },
    });
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([editedCommunity])} agents={[]} />,
    );
    await click(rowNamed(el, 'Comfy').querySelector('[title^="Update available"]')!);

    const d = dialog();
    expect(d!.textContent).toContain(EDITED_SKILL_UPDATE_MESSAGE);
    expect(d!.querySelector('[data-testid="edited-skill-text"] pre')?.textContent).toBe(MY_TEXT);
    // The upstream text is still shown for approval, as before.
    expect(d!.textContent).toContain('+ Upstream v2');
    // The old promise is gone: the edit is replaced, not kept.
    expect(d!.textContent).not.toContain('your local edits are kept');

    await click(dialogButton('Update'));
    expect(updateMock.mock.calls).toEqual([['comfy', 'hash-of-v2']]);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('a community skill the owner did NOT edit: the dialog as before, no edit warning', async () => {
    previewMock.mockResolvedValue({
      ok: true,
      data: {
        currentContent: 'Upstream v1',
        upstreamContent: 'Upstream v2',
        contentChanged: true,
        scriptsChanged: false,
        scriptNames: [],
        upstreamContentHash: 'hash-of-v2',
        contentOverridden: false,
      },
    });
    const untouched = { ...editedCommunity, content: 'Upstream v1', contentOverridden: false };
    const el = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([untouched])} agents={[]} />,
    );
    await click(rowNamed(el, 'Comfy').querySelector('[title="Update available"]')!);

    const d = dialog();
    expect(d!.textContent).toContain('Update skill "Comfy"?');
    expect(d!.textContent).not.toContain(EDITED_SKILL_UPDATE_MESSAGE);
    expect(d!.querySelector('[data-testid="edited-skill-text"]')).toBeNull();
    await click(dialogButton('Install this version'));
    expect(updateMock.mock.calls).toEqual([['comfy', 'hash-of-v2']]);
  });

  it('the skill screen (edit form) shows the badge and the same Update for an edited system skill', async () => {
    const el = render(<SkillForm mode="edit" initial={editedSystem} onClose={() => {}} />);
    expect(el.textContent).toContain('Update available');
    const update = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    );
    expect(update, 'no Update button on the skill screen').toBeDefined();
    await click(update!);
    expect(dialog()!.textContent).toContain(EDITED_SKILL_UPDATE_MESSAGE);
    await click(dialogButton('Update'));
    expect(resetMock.mock.calls).toEqual([['id-sys']]);
  });

  it('a skill with no newer version shows no badge on either screen', () => {
    const upToDate = { ...editedSystem, updateAvailable: false, updateDetail: null };
    const table = render(
      <SkillsAssignedTable segments={segmentSkillsByProvenance([upToDate])} agents={[]} />,
    );
    expect(rowNamed(table, 'Obsidian').textContent).not.toContain('Update available');
    act(() => root?.unmount());
    container?.remove();
    const form = render(<SkillForm mode="edit" initial={upToDate} onClose={() => {}} />);
    expect(form.textContent).not.toContain('Update available');
  });
});
