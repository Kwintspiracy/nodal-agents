// project-capture.test.tsx — le MARKUP RÉEL de la page d'un projet, écrit sur
// disque pour être photographié avec la feuille de style de l'application
// (le même geste que `sidebar-markup.capture.test.tsx`, pour la même raison :
// « ça devrait ressembler » n'est pas une vérification, et la stack de
// développement demande un compte que la session n'a pas).
//
// Il ne s'exécute que sur demande (`NODAL_CAPTURE=1` et un dossier de sortie),
// et il ne vérifie rien : il produit la pièce à conviction. Le rendu est celui
// du composant serveur, avec ses composants clients à leur état initial — donc
// le panneau OUVERT, comme au chargement.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/spaces/p-1',
}));

const facts = {
  id: 'p-1',
  name: 'Suivis Candidatures',
  path: 'C:/Users/kwint/Documents/Dev/applications-tracker',
  kind: 'code' as const,
  agentName: null,
  isGitRepository: true,
  conversations: 1,
  sessions: 0,
};

vi.mock('@/lib/project-actions.ts', () => ({
  getProjectFactsAction: async () => ({ ok: true, data: facts }),
  getProjectActivityAction: async () => ({
    ok: true,
    data: {
      conversations: [
        {
          id: 'c-1',
          channel: 'dashboard',
          title: 'Suivis Candidatures',
          agentName: 'Alfred',
          agentAvatarUrl: null,
          lastPreview:
            'Très bien ! Si un jour tu veux enrichir le tracker, exports CSV, statistiques de tes candidatures, un rappel hebdomadaire, dis-le moi.',
          sessions: 2,
          updatedAt: new Date('2026-09-19T10:00:00Z'),
          running: false,
          unread: false,
        },
      ],
      sessions: [],
    },
  }),
  getProjectPageAction: async () => ({
    ok: true,
    data: {
      project: {
        id: 'p-1',
        name: 'Suivis Candidatures',
        path: 'C:/Users/kwint/Documents/Dev/applications-tracker',
        kind: 'code',
        agentId: null,
        agentName: null,
        agentSlug: null,
        hidden: false,
        registeredFrom: 'spaces',
        registeredAt: new Date('2026-09-01T10:00:00Z'),
        jobsCount: 2,
        lastActivityAt: new Date('2026-09-19T10:00:00Z'),
        initGit: false,
        gitInitializedAt: null,
      },
      files: {
        entries: [
          { path: 'index.html', kind: 'file', size: 4210 },
          { path: 'app.js', kind: 'file', size: 12880 },
          { path: 'styles.css', kind: 'file', size: 2210 },
        ],
        more: 0,
        ignored: 3,
        unreadable: null,
      },
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

const SORTIE = process.env['NODAL_CAPTURE_DIR'] ?? '';
const ACTIF = process.env['NODAL_CAPTURE'] === '1' && SORTIE !== '';

describe.skipIf(!ACTIF)('capture — la page d’un projet', () => {
  it('écrit le markup de la page, dans la coquille de la disposition', async () => {
    const page = renderToStaticMarkup(await ProjectScreen({ id: 'p-1' }));
    // La coquille : la même que `app/(dashboard)/layout.tsx`, la barre
    // latérale remplacée par une colonne vide de sa largeur.
    const html =
      '<div class="fixed inset-0 flex overflow-hidden bg-canvas text-ink">' +
      '<div class="w-[var(--sidebar-w)] shrink-0 bg-sidebar"></div>' +
      '<main class="flex min-w-0 flex-1 flex-col">' +
      '<div class="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto">' +
      page +
      '</div></main></div>';
    mkdirSync(SORTIE, { recursive: true });
    writeFileSync(join(SORTIE, 'project.html'), html, 'utf8');
    expect(html).toContain('data-testid="project-files-panel"');
  });
});
