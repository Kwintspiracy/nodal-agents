// skill-files-review.test.tsx — the update review of a community skill says,
// file by file, what the runner will do: new, changed and removed files, the
// files kept (local changes, files added here) and the conflicts. The update
// cannot be confirmed while a conflict has no choice, and the choices made are
// what the action sends, with the pin of the reviewed files.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/actions.ts', () => ({
  installCommunitySkillAction: vi.fn(),
  previewCommunitySkillUpdateAction: vi.fn(),
  updateCommunitySkillAction: vi.fn(),
  acknowledgeSkillUpdateAction: vi.fn(),
}));

import PrimaryButton from '@/components/ui/PrimaryButton';
import SkillUpdateAction from '../SkillUpdateAction.tsx';
import InstallCommunitySkillModal from '../InstallCommunitySkillModal.tsx';
import {
  installCommunitySkillAction,
  previewCommunitySkillUpdateAction,
  updateCommunitySkillAction,
  type CommunitySkillUpdatePreview,
} from '@/lib/actions.ts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const PREVIEW: CommunitySkillUpdatePreview = {
  currentContent: 'v1',
  upstreamContent: 'v2',
  contentChanged: true,
  scriptsChanged: true,
  scriptNames: ['scripts/run.py', 'scripts/new.py'],
  scriptsToAuthorize: ['scripts/new.py'],
  upstreamContentHash: 'a'.repeat(64),
  files: [
    { path: 'SKILL.md', kind: 'changed' },
    { path: 'references/guide.md', kind: 'conflict', reason: 'both-changed' },
    { path: 'references/old.md', kind: 'conflict', reason: 'edited-locally-removed-upstream' },
    { path: 'scripts/new.py', kind: 'added' },
    { path: 'workflows/mine.json', kind: 'kept-local-addition' },
  ],
  filesState: 'conflict',
  upstreamFilesHash: 'b'.repeat(64),
  contentOverridden: false,
};

function buttonByText(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

function segment(path: string, label: string): HTMLButtonElement {
  const li = document.querySelector(`[data-testid="skill-file-conflict-${path}"]`);
  if (!li) throw new Error(`no conflict row for ${path}`);
  const b = [...li.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no "${label}" for ${path}`);
  return b as HTMLButtonElement;
}

describe('the update review of a skill, file by file @cap:apprendre-une-skill/ecran', () => {
  it('lists every file, blocks the update until each conflict is chosen, and sends the choices', async () => {
    vi.mocked(previewCommunitySkillUpdateAction).mockResolvedValue({ ok: true, data: PREVIEW });
    vi.mocked(updateCommunitySkillAction).mockResolvedValue({
      ok: true,
      data: {
        contentChanged: true,
        scriptsChanged: true,
        scriptsAuthorizationRevoked: 1,
        leftoverDir: null,
      },
    });

    act(() =>
      root!.render(
        <SkillUpdateAction
          slug="comfy"
          name="Comfy"
          updateDetail={{
            contentChanged: true,
            scriptsChanged: true,
            scriptsState: 'update',
            filesState: 'conflict',
            checkedAt: '2026-11-28T00:00:00.000Z',
          }}
          hasScripts
        >
          {({ onClick }) => (
            <PrimaryButton variant="coral" onClick={onClick}>
              Update
            </PrimaryButton>
          )}
        </SkillUpdateAction>,
      ),
    );
    await act(async () => buttonByText('Update').click());

    const review = document.querySelector('[data-testid="skill-files-review"]');
    expect(review?.textContent).toContain('New in this version (1)');
    expect(review?.textContent).toContain('scripts/new.py');
    expect(review?.textContent).toContain('Changed in this version (1)');
    expect(review?.textContent).toContain('Kept: files added here (1)');
    expect(review?.textContent).toContain('workflows/mine.json');
    expect(review?.textContent).toContain('Changed here and in the new version');
    expect(review?.textContent).toContain('Changed here, removed in the new version');
    expect(document.body.textContent).toContain('Not authorized yet: scripts/new.py');

    const confirm = buttonByText('Install this version');
    expect(confirm.disabled).toBe(true);
    await act(async () => segment('references/guide.md', 'Keep mine').click());
    expect(buttonByText('Install this version').disabled).toBe(true);
    await act(async () => segment('references/old.md', 'Remove it').click());
    expect(buttonByText('Install this version').disabled).toBe(false);

    await act(async () => buttonByText('Install this version').click());
    expect(vi.mocked(updateCommunitySkillAction).mock.calls).toEqual([
      [
        'comfy',
        'a'.repeat(64),
        {
          expectedFilesHash: 'b'.repeat(64),
          conflictChoices: {
            'references/guide.md': 'keep-local',
            'references/old.md': 'take-upstream',
          },
        },
      ],
    ]);
  });

  it('an update with no conflict can be confirmed at once and sends no choice', async () => {
    vi.mocked(previewCommunitySkillUpdateAction).mockResolvedValue({
      ok: true,
      data: {
        ...PREVIEW,
        files: [
          { path: 'SKILL.md', kind: 'changed' },
          { path: 'notes/added.md', kind: 'kept-local-addition' },
        ],
        filesState: 'update',
      },
    });
    vi.mocked(updateCommunitySkillAction).mockResolvedValue({
      ok: true,
      data: {
        contentChanged: true,
        scriptsChanged: false,
        scriptsAuthorizationRevoked: 0,
        leftoverDir: null,
      },
    });
    act(() =>
      root!.render(
        <SkillUpdateAction slug="plain" name="Plain" updateDetail={null} hasScripts={false}>
          {({ onClick }) => (
            <PrimaryButton variant="coral" onClick={onClick}>
              Update
            </PrimaryButton>
          )}
        </SkillUpdateAction>,
      ),
    );
    await act(async () => buttonByText('Update').click());
    expect(buttonByText('Install this version').disabled).toBe(false);
    await act(async () => buttonByText('Install this version').click());
    expect(vi.mocked(updateCommunitySkillAction).mock.calls[0]).toEqual([
      'plain',
      'a'.repeat(64),
      { expectedFilesHash: 'b'.repeat(64), conflictChoices: {} },
    ]);
  });

  it('installing a source already installed changes nothing and leads to the update review', async () => {
    vi.mocked(installCommunitySkillAction).mockResolvedValue({
      ok: true,
      data: {
        status: 'already_installed',
        slug: 'comfy',
        name: 'Comfy',
        description: 'd',
        source: 'owner/repo',
        updateAvailable: true,
        updateDetail: null,
        hasScripts: false,
      },
    });
    vi.mocked(previewCommunitySkillUpdateAction).mockResolvedValue({ ok: true, data: PREVIEW });
    act(() => root!.render(<InstallCommunitySkillModal open onClose={() => {}} />));
    const input = document.querySelector('#skill-source') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'owner/repo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttonByText('Install').click());

    const block = document.querySelector('[data-testid="skill-already-installed"]');
    expect(block?.textContent).toContain(
      'is already installed from this source. Nothing was changed.',
    );
    expect(document.body.textContent).not.toContain('Installed:');
    await act(async () => buttonByText('Review update').click());
    expect(vi.mocked(previewCommunitySkillUpdateAction).mock.calls).toEqual([['comfy']]);
    expect(document.querySelector('[data-testid="skill-files-review"]')?.textContent).toContain(
      'workflows/mine.json',
    );
  });
});
