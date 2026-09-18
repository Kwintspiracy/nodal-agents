// CodeProcessesTable.sessions.test.tsx — les sessions d'un projet MÈNENT à
// leur page.
//
// Elles se dépliaient dans cette liste, sous un sélecteur. Un run est une PAGE
// — c'est ce que font Scheduled et Activity — et le corps d'un run porte la
// boîte d'une page entière, qui rétrécissait en s'emboîtant dans celle-ci
// (Quentin, 18/09 : « tout ce qui est en dessous a soudainement réduit en
// largeur »). Ce qui se prouve ici : une ligne par session, un lien vers sa
// page, et aucun corps de run dans la liste.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodingProcessRow } from '@/lib/actions.ts';
import CodeProcessesTable from '../CodeProcessesTable.tsx';

vi.mock('@/lib/actions.ts', () => ({
  listCodingProcessesAction: vi.fn(async () => ({ ok: true as const, data: [] as never[] })),
  setCodeProjectHiddenAction: vi.fn(),
  renameCodeProjectAction: vi.fn(),
  // Importées par `ProjectVerificationPanel`, que cette page charge.
  approveCodeProjectVerifyManifestAction: vi.fn(),
  discoverVerifyCommandsAction: vi.fn(async () => ({ ok: true as const, data: [] as never[] })),
  listCodeProjectPrefsAction: vi.fn(async () => ({ ok: true as const, data: [] as never[] })),
  setCodeProjectVerifyCommandsAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';

const row = (over: Partial<CodingProcessRow> = {}): CodingProcessRow => ({
  id: JOB_ID,
  kind: 'job',
  agentId: null,
  agentName: 'Ada',
  origin: 'api',
  status: 'completed',
  stage: 'done',
  task: 'Unfolding a block must not move the scroll',
  costUsd: 1.92,
  providers: ['claude'],
  filesChanged: 2,
  activityAt: '2026-09-18T10:00:00.000Z',
  projectPath: 'D:/APPS/NodalAI',
  projectName: 'NodalAI',
  sessionType: 'coding',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

async function openProject(rows: CodingProcessRow[]): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <CodeProcessesTable
        initialRows={rows}
        initialPrefs={[]}
        isOwner
        workspaceCount={1}
        hiddenWorkspaceCount={0}
      />,
    );
  });
  // Le projet s'ouvre au clic sur sa carte — c'est là que vivent les sessions.
  const card = Array.from(container.querySelectorAll('button, [role="button"]')).find((el) =>
    (el.textContent ?? '').includes('NodalAI'),
  );
  if (!card) throw new Error('no project card rendered');
  await act(async () => {
    (card as HTMLElement).click();
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CodeProcessesTable — les sessions d’un projet @cap:suivre-execution/ecran', () => {
  it('chaque session est une ligne qui mène à SA page', async () => {
    await openProject([
      row(),
      row({ id: '22222222-2222-4222-8222-222222222222', stage: 'coding' }),
    ]);

    const liens = Array.from(container.querySelectorAll('a[href^="/code/"]')).map((a) =>
      a.getAttribute('href'),
    );
    expect(liens).toEqual([
      `/code/job-${JOB_ID}`,
      '/code/job-22222222-2222-4222-8222-222222222222',
    ]);

    const ligne = container.querySelector(`[data-testid="session-row-job-${JOB_ID}"]`);
    const texte = ligne?.textContent ?? '';
    expect(texte).toContain('Ada');
    expect(texte).toContain('Unfolding a block must not move the scroll');
    expect(texte).toContain('Done');
    expect(texte).toContain('$1.92');
  });

  it('aucun corps de run dans la liste : le run vit sur sa page', async () => {
    await openProject([row()]);
    expect(container.querySelector('[data-testid="run-body"]')).toBeNull();
    expect(container.querySelector('[data-testid="activity-section"]')).toBeNull();
    expect(container.textContent).not.toContain('Loading session…');
  });
});
