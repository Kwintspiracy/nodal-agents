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
  it('en-tête avec le chemin, puis les actions, puis le contenu, puis le panneau flottant', () => {
    // Planche 498:5776 (20/09) : plus de WorkBar, le chemin est dans l'en-tête ;
    // la rangée d'actions ouvre le corps centré ; le panneau flotte à droite.
    const iTitre = html.indexOf('Nodal Agents');
    const iChemin = html.indexOf('D:/APPS/NodalAI');
    const iCorps = html.indexOf('data-testid="project-body"');
    const iActions = html.indexOf('data-testid="action-row"');
    const iListe = html.indexOf('data-testid="project-activity"');
    const iPanneau = html.indexOf('data-testid="project-files-panel"');

    for (const [nom, i] of Object.entries({ iTitre, iChemin, iCorps, iActions, iPanneau })) {
      expect(i, `${nom} absent de la page`).toBeGreaterThan(-1);
    }
    expect(html).not.toContain('data-testid="work-bar"');
    expect(iChemin).toBeGreaterThan(iTitre);
    expect(iCorps).toBeGreaterThan(iChemin);
    expect(iActions).toBeGreaterThan(iCorps);
    // La liste est vide dans ce doublage : c'est l'état vide qui la remplace.
    expect(iPanneau).toBeGreaterThan(iActions);
    if (iListe > -1) expect(iPanneau).toBeGreaterThan(iListe);
  });

  it('le corps a la largeur des autres pages, et le panneau est une colonne à côté', () => {
    const iCorps = html.indexOf('data-testid="project-body"');
    const corps = html.slice(iCorps, html.indexOf('>', iCorps));
    // Une rangée : la colonne de contenu, puis le panneau collant à droite.
    expect(corps).toContain('lg:flex-row');
    // La colonne aux mesures de `PageShell` : `max-w-6xl` GOUTTIÈRES COMPRISES.
    expect(html.slice(iCorps)).toContain('mx-auto flex w-full max-w-6xl flex-col gap-4 px-5');
    const iPanneau = html.indexOf('data-testid="project-files-panel"');
    const panneau = html.slice(iPanneau, html.indexOf('>', iPanneau));
    expect(panneau).toContain('lg:sticky lg:top-6');
    expect(panneau).toContain('lg:w-[400px]');
    // Le sous-titre est le CHEMIN seul : pas d'agent, pas de compte.
    expect(html).not.toContain('1 conversation');
    expect(html).not.toContain('2 conversations');
  });

  it('AUCUN retour, et les gestes sont à la taille standard', () => {
    // #242, second temps : le soir du 19/09, Quentin a fait retirer les retours
    // PARTOUT. Et le 20/09 : les boutons du projet avaient la petite taille.
    expect(html).not.toContain('href="/spaces"');
    const iActions = html.indexOf('data-testid="action-row"');
    // La rangée seule : ses enfants directs sont les trois gestes.
    const rangee = html.slice(iActions, html.indexOf('</div>', iActions));
    expect(rangee).toContain('project-panel-toggle');
    expect(rangee).not.toContain('h-[30px]');
    expect(rangee).toContain('h-[34px]');
  });

  it('les trois gestes du projet sont sur la rangée d’actions', () => {
    const iActions = html.indexOf('data-testid="action-row"');
    const apres = html.slice(iActions);
    expect(apres).toContain('New conversation');
    expect(apres).toContain('Rename');
    expect(apres).toContain('project-panel-toggle');
  });
});
