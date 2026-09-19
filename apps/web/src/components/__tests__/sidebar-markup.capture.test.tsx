// sidebar-markup.capture.test.tsx — le MARKUP RÉEL de la barre, écrit sur
// disque pour être comparé à la planche (#230, 19/09/2026).
//
// POURQUOI CE FICHIER EXISTE. Les planches de Quentin (Figma 487:5489,
// 487:5579, 487:5652) sont la spécification, et « ça devrait ressembler » n'est
// pas une vérification. Comparer demande une IMAGE du rendu ; or la stack de
// développement ne m'est pas accessible, et un test jsdom ne sait pas
// dessiner.
//
// Ce test rend donc les trois panneaux avec les VRAIS composants, dans les
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
vi.mock('@/lib/actions', () => ({
  listApprovalsAction: vi.fn(),
  switchWorkspaceAction: vi.fn(),
  createWorkspaceAction: vi.fn(),
}));
vi.mock('@/lib/conversation-actions.ts', () => ({
  getChatFoldersAction: vi.fn(),
  listRecentThreadReadsAction: vi.fn(),
}));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));
vi.mock('@/lib/actions.ts', () => ({
  getVersionInfoAction: vi.fn(async () => ({
    ok: true as const,
    data: { current: '0.8.11', latest: '0.8.11', updateAvailable: false },
  })),
}));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listRecentThreadReadsAction } from '@/lib/conversation-actions.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';

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

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(listRecentThreadReadsAction).mockResolvedValue({
    ok: true,
    data: [
      { id: 'r1', title: 'Suivis Candidatures', unread: false },
      { id: 'r2', title: 'Recipes', unread: false },
      {
        id: 'r3',
        title: 'Crée-moi une app assez simple pour suivre mes candidatures',
        unread: false,
      },
      { id: 'r4', title: 'Créer un skill avec CSS et HTML', unread: false },
      { id: 'r5', title: 'Explication du cache de prompt', unread: false },
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
    ['talk', '/chat', ['telegram', 'discord', 'whatsapp']],
    ['build', '/agents', []],
    ['run', '/', []],
  ];

  for (const [nom, route, channels] of cas) {
    it(`écrit ${nom}.html`, async () => {
      pathname = route;
      await render(
        <ApprovalsProvider
          initial={[
            {
              id: 'a1',
              jobId: 'j1',
              toolName: 'send_message',
              agentName: null,
              toolInput: {},
              requestedAt: null,
              jobChannel: 'dashboard',
              conversationChannel: 'dashboard',
            },
          ]}
        >
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
