// routes.test.tsx — QUI répond à quelle adresse depuis #248.
//
// La racine `/` rendait le Dashboard ; elle rend la conversation neuve. Le
// Dashboard n'a pas changé, il a changé d'adresse : `/dashboard`. Les deux
// pages sont RENDUES ici, et l'assertion porte sur ce qu'elles montrent — un
// test qui se contenterait de vérifier que les fichiers existent resterait vert
// si on remettait le Dashboard sur la racine.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NewConversationPage from '../page.tsx';
import DashboardPage from '../dashboard/page.tsx';

const ok = <T,>(data: T) => ({ ok: true as const, data });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

vi.mock('@/lib/conversation-actions.ts', () => ({
  getNewConversationAction: vi.fn(async () =>
    ok({
      accountName: 'Quentin',
      root: { id: 'a-1', name: 'Alfred', avatarUrl: null },
      project: null,
    }),
  ),
}));

vi.mock('@/lib/project-actions.ts', () => ({
  createProjectConversationAction: vi.fn(),
}));

vi.mock('@/lib/actions.ts', () => ({
  // L'écran de conversation neuve
  createConversationAction: vi.fn(),
  getAgentModelChoicesAction: vi.fn(async () =>
    ok({ llmKeyId: null, model: '', reasoningEffort: null, llmKeys: [], requireTools: false }),
  ),
  getFeedDensityAction: vi.fn(async () => ok('folded')),
  setAgentModelAndEffortAction: vi.fn(),
  listKeyModelsAction: vi.fn(async () => ok([])),
  // Le Dashboard
  getEntityStatsAction: vi.fn(async () =>
    ok({
      agentCount: 3,
      totalJobs: 12,
      totalToolCalls: 4,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      statusCounts: { completed: 12 },
      perAgent: [],
    }),
  ),
  getActiveJobsByAgentAction: vi.fn(async () => ok([])),
  getWeeklyActivityAction: vi.fn(async () => ok({ rows: [], models: [] })),
  getDailyActivityAction: vi.fn(async () => ok({ rows: [], models: [] })),
  listSkillsAction: vi.fn(async () => ok([])),
  listConnectorsAction: vi.fn(async () => ok({ instances: [] })),
  listMcpServersAction: vi.fn(async () => ok({ instances: [] })),
}));

describe('les adresses du produit @cap:parler-a-un-agent/ecran', () => {
  it('`/` ouvre une conversation neuve — c’est le défaut de Nodal', async () => {
    const html = renderToStaticMarkup(
      await NewConversationPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('Hey Quentin, what are we building today?');
    expect(html).toContain('<textarea');
    // Et plus le tableau de chiffres : les cartes du Dashboard n'y sont plus.
    expect(html).not.toContain('Total jobs');
    expect(html).not.toContain('Success rate');
  });

  it('`/dashboard` rend le Dashboard, entier', async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain('Total jobs');
    expect(html).toContain('Success rate');
    expect(html).toContain('Tokens / job');
    // Et pas l'accueil du fil : ce sont deux écrans, à deux adresses.
    expect(html).not.toContain('what are we building today?');
  });

  it('`/?project=<id>` porte le projet jusqu’à la saisie', async () => {
    const { getNewConversationAction } = await import('@/lib/conversation-actions.ts');
    vi.mocked(getNewConversationAction).mockResolvedValueOnce(
      ok({
        accountName: 'Quentin',
        root: { id: 'a-1', name: 'Alfred', avatarUrl: null },
        project: { id: 'p-1', name: 'Nodal' },
      }),
    );
    const html = renderToStaticMarkup(
      await NewConversationPage({ searchParams: Promise.resolve({ project: 'p-1' }) }),
    );
    // Le projet est lu AVEC son identifiant, pas deviné.
    expect(vi.mocked(getNewConversationAction).mock.calls.at(-1)).toEqual(['p-1']);
    expect(html).toContain('/spaces/p-1/files');
  });

  it('un chargement en échec se DIT, il ne rend pas une saisie sans destination', async () => {
    const { getNewConversationAction } = await import('@/lib/conversation-actions.ts');
    vi.mocked(getNewConversationAction).mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
      message: 'Project not found',
    });
    const html = renderToStaticMarkup(
      await NewConversationPage({ searchParams: Promise.resolve({ project: 'p-inconnu' }) }),
    );
    expect(html).toContain('Project not found');
    expect(html).not.toContain('<textarea');
  });
});
