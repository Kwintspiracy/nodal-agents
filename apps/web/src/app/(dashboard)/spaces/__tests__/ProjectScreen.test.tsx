// ProjectScreen.test.tsx — L'ORDRE de la page d'un projet (#143, #242).
//
// En-tête, WorkBar avec le retour DEDANS, rangée d'actions SOUS la barre, puis
// la rangée contenu / panneau. C'est la règle de #242, et elle ne se relit pas
// à l'œil à chaque PR : une action qui remonte d'une rangée retombe sur la
// ligne du retour, et c'est exactement le retour que Quentin a donné page
// après page.
//
// `PageShellOrder.test.tsx` prouve que le `PageShell` TIENT cet ordre. Ce
// fichier-ci prouve que la page du projet le lui DEMANDE : les deux sont
// nécessaires, une page peut très bien passer ses actions au mauvais endroit
// d'un shell parfaitement ordonné.
//
// La page est un composant serveur asynchrone : on l'attend, puis on rend ce
// qu'elle a produit. Les six lectures sont doublées — ce qui est prouvé ici est
// la STRUCTURE, pas la base.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/spaces/p-1',
}));

const facts = {
  id: 'p-1',
  name: 'Nodal Agents',
  path: 'D:/APPS/NodalAI',
  kind: 'code' as const,
  agentName: null,
  isGitRepository: true,
  conversations: 2,
  sessions: 3,
};

vi.mock('@/lib/project-actions.ts', () => ({
  getProjectFactsAction: async () => ({ ok: true, data: facts }),
  getProjectActivityAction: async () => ({ ok: true, data: { conversations: [], sessions: [] } }),
  getProjectPageAction: async () => ({
    ok: true,
    data: {
      project: {
        id: 'p-1',
        name: 'Nodal Agents',
        path: 'D:/APPS/NodalAI',
        kind: 'code',
        agentId: null,
        agentName: null,
        agentSlug: null,
        hidden: false,
        registeredFrom: 'spaces',
        registeredAt: new Date('2026-09-01T10:00:00Z'),
        jobsCount: 0,
        lastActivityAt: null,
      },
      files: { entries: [], more: 0, ignored: 0, unreadable: null },
      proof: { configured: false, commands: null, approval: 'not_configured', sequences: [] },
      conversations: [],
      projectConversationId: null,
    },
  }),
  registerDetectedProjectAction: async () => ({ ok: true, data: { id: 'x', path: 'x' } }),
}));

vi.mock('@/lib/actions.ts', () => ({
  listApprovalsAction: async () => ({ ok: true, data: [] }),
  listCodeProjectPrefsAction: async () => ({ ok: true, data: [] }),
  getCodeTabOwnerAction: async () => ({ ok: true, data: { isOwner: true } }),
  renameCodeProjectAction: async () => ({ ok: true }),
  setCodeProjectHiddenAction: async () => ({ ok: true }),
}));

import ProjectScreen from '../ProjectScreen.tsx';

let html = '';

beforeEach(async () => {
  html = renderToStaticMarkup(await ProjectScreen({ id: 'p-1' }));
});

describe('ProjectScreen — l’ordre de la page @cap:travailler-sur-des-fichiers/ecran', () => {
  it('en-tête, puis la barre, puis les actions, puis le contenu et son panneau', () => {
    const iTitre = html.indexOf('Nodal Agents');
    const iBarre = html.indexOf('data-testid="work-bar"');
    const iActions = html.indexOf('data-testid="action-row"');
    const iListe = html.indexOf('data-testid="project-activity"');
    const iPanneau = html.indexOf('data-testid="project-files-panel"');

    for (const [nom, i] of Object.entries({ iTitre, iBarre, iActions, iPanneau })) {
      expect(i, `${nom} absent de la page`).toBeGreaterThan(-1);
    }
    expect(iBarre).toBeGreaterThan(iTitre);
    expect(iActions).toBeGreaterThan(iBarre);
    // La liste est vide dans ce doublage : c'est l'état vide qui la remplace.
    expect(iPanneau).toBeGreaterThan(iActions);
    if (iListe > -1) expect(iPanneau).toBeGreaterThan(iListe);
  });

  it('AUCUN retour dans la barre : elle ne dit que le contexte', () => {
    // #242, second temps : le soir du 19/09, Quentin a fait retirer les retours
    // PARTOUT. La barre garde ce que la page EST — ici le chemin du projet —
    // et on repart par la barre latérale.
    const iBarre = html.indexOf('data-testid="work-bar"');
    const iActions = html.indexOf('data-testid="action-row"');
    const barre = html.slice(iBarre, iActions);
    expect(iBarre).toBeGreaterThan(-1);
    expect(barre).not.toContain('href="/spaces"');
    expect(barre).not.toContain('Workspaces');
  });

  it('AUCUNE action n’est dans la barre', () => {
    // Le constat du 19/09 : une action sur la ligne de la barre brouille ce
    // que la barre dit.
    const iBarre = html.indexOf('data-testid="work-bar"');
    const iActions = html.indexOf('data-testid="action-row"');
    const barre = html.slice(iBarre, iActions);
    expect(barre).not.toContain('New conversation');
    expect(barre).not.toContain('Rename');
    expect(barre).not.toContain('project-panel-toggle');
  });

  it('les trois gestes du projet sont sur la rangée d’actions', () => {
    const iActions = html.indexOf('data-testid="action-row"');
    const apres = html.slice(iActions);
    expect(apres).toContain('New conversation');
    expect(apres).toContain('Rename');
    expect(apres).toContain('project-panel-toggle');
  });
});
