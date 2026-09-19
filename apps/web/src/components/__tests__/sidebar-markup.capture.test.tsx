// sidebar-markup.capture.test.tsx — le MARKUP RÉEL de la barre, écrit sur
// disque pour être comparé à la planche (#230, refondu en #258).
//
// POURQUOI CE FICHIER EXISTE. Les planches du propriétaire (Figma
// `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`) sont la spécification, et « ça
// devrait ressembler » n'est pas une vérification. Comparer demande une IMAGE
// du rendu ; or la stack de développement ne m'est pas accessible, et un test
// jsdom ne sait pas dessiner.
//
// Ce test rend donc les CINQ panneaux avec les VRAIS composants, dans les
// VRAIS providers, et écrit le HTML obtenu. Un script à côté
// (`scripts/capture-sidebar.mjs`) compile la feuille de style de
// l'application, pose ce HTML dedans et le photographie avec le navigateur de
// Playwright. Ce qui est photographié est donc le rendu du produit, pas une
// maquette réécrite pour l'occasion.
//
// ⚠️ IL NE VÉRIFIE RIEN PAR LUI-MÊME, et c'est voulu : il PRODUIT la pièce à
// conviction. Les mesures, elles, sont vérifiées par `Sidebar.test.tsx`, qui
// lit les classes rendues. Il ne s'exécute que lorsqu'on le lui demande
// (`NODAL_CAPTURE=1`), pour ne pas écrire des fichiers pendant une suite
// ordinaire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let pathname = '/chat';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(''),
  // Le sélecteur d'espace le demande pour rafraîchir après un changement ;
  // rien ne change ici, il ne sera jamais appelé.
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
// UN SEUL faux pour ce module, et il porte TOUT ce que la barre lui demande.
// `@/lib/actions` et `@/lib/actions.ts` désignent le même fichier : deux
// `vi.mock` se remplacent l'un l'autre, et celui qui perd emporte ses
// fonctions — c'est ce qui a fait tomber la capture le jour où le rail a pris
// la ligne de version (#258).
vi.mock('@/lib/actions', () => ({
  listApprovalsAction: vi.fn(),
  switchWorkspaceAction: vi.fn(),
  createWorkspaceAction: vi.fn(),
  getVersionInfoAction: vi.fn(async () => ({
    ok: true as const,
    data: { current: '0.8.11', latest: '0.8.11', updateAvailable: false },
  })),
}));
vi.mock('@/lib/conversation-actions.ts', () => ({ getChatFoldersAction: vi.fn() }));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));
vi.mock('@/lib/project-actions.ts', () => ({ listSidebarProjectsAction: vi.fn() }));
vi.mock('@/lib/sidebar-actions.ts', () => ({
  listSidebarAgentsAction: vi.fn(),
  listSidebarCronAction: vi.fn(),
  listSidebarWebhooksAction: vi.fn(),
  listSidebarRecentApprovalsAction: vi.fn(),
}));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import {
  listSidebarAgentsAction,
  listSidebarCronAction,
  listSidebarWebhooksAction,
  listSidebarRecentApprovalsAction,
} from '@/lib/sidebar-actions.ts';

const SORTIE = process.env['NODAL_CAPTURE_DIR'] ?? '';
const ACTIF = process.env['NODAL_CAPTURE'] === '1' && SORTIE !== '';

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

/** Les espaces de travail, tels que la planche les montre : un seul, « Local ». */
const ESPACES = [
  {
    id: 'w1',
    name: 'Local',
    slug: 'local',
    icon: null,
    active: true,
  },
] as unknown as Parameters<typeof Sidebar>[0]['workspaces'];

/** Les fils du dossier « Nodal chats », tels que la planche les écrit. */
const FILS = [
  ['d1', 'Suivis Candidatures', true],
  ['d2', 'Recipes', true],
  ['d3', 'Crée-moi une app assez simple', false],
  ['d4', 'Créer un skill avec CSS et HTML', false],
  ['d5', 'Explication du cache de prompt', false],
  ['d6', 'Explication du cache de prompt', false],
  ['d7', 'Explication du cache de prompt', false],
  ['d8', 'Explication du cache de prompt', false],
  ['d9', 'Explication du cache de prompt', false],
  ['d10', 'Explication du cache de prompt', false],
  // La ONZIÈME : jamais dessinée, elle est ce qui fait apparaître « See all ».
  ['d11', 'Explication du cache de prompt', false],
] as const;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listFolderThreadsAction).mockResolvedValue({
    ok: true,
    data: {
      dashboard: FILS.map(([key, title, unread]) => ({
        key,
        title,
        href: `/chat/${key}`,
        waiting: false,
        running: false,
        unread,
      })),
    },
  });
  vi.mocked(listSidebarProjectsAction).mockResolvedValue({
    ok: true,
    data: [
      { id: 'p1', name: 'Suivis Candidatures', unread: true },
      { id: 'p2', name: 'Recipes', unread: false },
      { id: 'p3', name: 'Drink Water App', unread: false },
      { id: 'p4', name: 'Calories Count', unread: false },
      { id: 'p5', name: 'Suivis Candidatures', unread: false },
    ],
  });
  vi.mocked(listSidebarAgentsAction).mockResolvedValue({
    ok: true,
    data: [
      { id: 'a1', name: 'Alfred (Root)' },
      { id: 'a2', name: 'Researcher' },
      { id: 'a3', name: 'Lead-Dev' },
      { id: 'a4', name: 'Dev-A' },
      { id: 'a5', name: 'Reviewer-A' },
    ],
  });
  vi.mocked(listSidebarCronAction).mockResolvedValue({
    ok: true,
    data: [{ id: 'c1', name: 'Cortex All' }],
  });
  // VIDE, et c'est le sujet : la planche dessine le cadre en pointillés de
  // WEBHOOKS et celui d'APPROVALS, et il n'y a que là qu'on peut les voir.
  vi.mocked(listSidebarWebhooksAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarRecentApprovalsAction).mockResolvedValue({
    ok: true,
    data: [
      { id: 'r1', name: 'Researcher', toolName: 'web_search' },
      { id: 'r2', name: 'Researcher', toolName: 'web_search' },
      { id: 'r3', name: 'Researcher', toolName: 'web_search' },
      { id: 'r4', name: 'Researcher', toolName: 'web_search' },
    ],
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe.runIf(ACTIF)('capture du markup de la barre latérale', () => {
  const cas: ReadonlyArray<readonly [string, string, string[]]> = [
    ['work', '/chat', ['telegram', 'discord', 'whatsapp', 'mcp']],
    ['agents', '/agents', []],
    ['run', '/automations', []],
    ['approvals', '/approvals', []],
    ['settings', '/settings', []],
  ];

  for (const [nom, route, channels] of cas) {
    it(`écrit ${nom}.html`, async () => {
      pathname = route;
      await render(
        // AUCUNE demande en attente : la planche dessine le cadre
        // « No Approval Requests », et la pastille du rail n'apparaît donc pas
        // non plus. C'est l'état qu'elle montre, et c'est celui qu'on
        // photographie.
        <ApprovalsProvider initial={[]}>
          <ChatFoldersProvider
            initial={{
              channels,
              running: {},
              runningConversationIds: [],
              externalRuns: 1,
            }}
          >
            <Sidebar workspaces={ESPACES} userMenu={<p>quentinbeau@gmail.com</p>} initiale="Q" />
          </ChatFoldersProvider>
        </ApprovalsProvider>,
      );

      mkdirSync(SORTIE, { recursive: true });
      writeFileSync(join(SORTIE, `${nom}.html`), container.innerHTML, 'utf8');
      // Le markup n'est pas vide : sans ça, le script photographierait du blanc
      // et la comparaison dirait « conforme » pour la pire des raisons.
      expect(container.querySelector('[data-testid="sidebar-panel"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="sidebar-rail"]')).not.toBeNull();
    });
  }
});
