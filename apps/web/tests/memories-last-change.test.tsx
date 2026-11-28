/**
 * memories-last-change.test.tsx — #1144, the screen side.
 *
 * When a fact's last change was made by an automatic pass or an agent, its
 * row on the Memory page says who changed it, and offers the text it had
 * before: the confirm dialog shows that previous text, and confirming asks to
 * put back exactly that version, for the version of the row the page shows.
 * A fact nobody but the owner changed offers nothing. Every other change of
 * the row also states the version it was shown.
 *
 * What happens in the database is proved by
 * apps/web/src/lib/__tests__/memory-actions.test.ts and
 * packages/memory/src/tests/mutate.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const actions = vi.hoisted(() => ({
  restoreMemoryVersionAction: vi.fn(async () => ({ ok: true, data: undefined })),
  archiveMemoryAction: vi.fn(async () => ({ ok: true, data: undefined })),
}));

vi.mock('@/lib/actions', () => ({
  searchMemoriesAction: vi.fn(),
  archiveMemoryAction: actions.archiveMemoryAction,
  unarchiveMemoryAction: vi.fn(),
  deleteMemoryAction: vi.fn(),
  updateMemoryImportanceAction: vi.fn(),
  unpinMemoryImportanceAction: vi.fn(),
  restoreMemoryVersionAction: actions.restoreMemoryVersionAction,
  createMemoryAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { default: MemoriesClient } =
  await import('../src/app/(dashboard)/memories/MemoriesClient.tsx');

const PREVIOUS =
  'Backups run at 2am and are kept 30 days; the restore key is in the vault under ops.';

const row = (id: string, fact: string, version: number, lastChange: unknown) => ({
  id,
  entity_id: 'e1',
  agent_id: null,
  agentName: null,
  agentSlug: null,
  fact,
  category: 'context',
  importance: 3,
  importance_locked: false,
  version,
  archived: false,
  skill_tags: [],
  source: 'agent',
  access_count: 0,
  last_accessed_at: null,
  created_at: new Date('2026-11-01T10:00:00Z').toISOString(),
  updated_at: new Date('2026-11-20T10:00:00Z').toISOString(),
  lastChange,
});

const ITEMS = [
  row('m1', 'Backups run at 2am.', 2, {
    versionId: 'v-1',
    changedBy: 'curator',
    agentName: null,
    action: 'edit',
    previousFact: PREVIOUS,
    changedAt: new Date('2026-11-20T10:00:00Z').toISOString(),
  }),
  row('m2', 'A fact only the owner changed.', 4, null),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.restoreMemoryVersionAction.mockClear();
  actions.archiveMemoryAction.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      <MemoriesClient
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test row is a MemoryListRow structurally; typing it would import the type from the mocked module.
        initialItems={ITEMS as any}
        agents={[] as never}
        totalCount={ITEMS.length}
      />,
    );
  });
}

function rowOf(fact: string): HTMLTableRowElement {
  const cell = Array.from(document.querySelectorAll('tr')).find((tr) =>
    (tr.textContent ?? '').includes(fact),
  );
  expect(cell, `no row for "${fact}"`).toBeTruthy();
  return cell as HTMLTableRowElement;
}

describe('the Memory page shows a change made by an automatic pass, and puts the previous text back (#1144) @cap:se-souvenir/ecran', () => {
  it('the changed row names the pass and offers the previous text; the owner-only row offers nothing', async () => {
    await render();
    const changed = rowOf('Backups run at 2am.');
    expect(changed.textContent).toContain('changed by the weekly memory pass');
    const restore = changed.querySelector('button[title^="Restore the text before"]');
    expect(restore).toBeTruthy();

    const untouched = rowOf('A fact only the owner changed.');
    expect(untouched.textContent).not.toContain('changed by');
    expect(untouched.querySelector('button[title^="Restore the text before"]')).toBeNull();
  });

  it('confirming restores exactly that version, for the version the row shows', async () => {
    await render();
    const restore = rowOf('Backups run at 2am.').querySelector(
      'button[title^="Restore the text before"]',
    ) as HTMLButtonElement;
    await act(async () => restore.click());

    // The dialog shows the previous text in full.
    expect(document.body.textContent).toContain(PREVIOUS);
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore',
    );
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());

    expect(actions.restoreMemoryVersionAction.mock.calls).toEqual([['m1', 'v-1', 2]]);
  });

  it('archive sends the version the row shows', async () => {
    await render();
    const archive = rowOf('A fact only the owner changed.').querySelector(
      'button[title="Archive"]',
    ) as HTMLButtonElement;
    await act(async () => archive.click());
    expect(actions.archiveMemoryAction.mock.calls).toEqual([['m2', 4]]);
  });
});
