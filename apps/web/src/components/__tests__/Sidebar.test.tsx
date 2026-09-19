// Sidebar.test.tsx — la barre latérale À L'ÉCRAN (retouches du 18/09/2026).
//
// Huit demandes de Quentin, dont sept se voient dans ce fichier : le libellé
// des entrées, l'ordre du groupe « Operate », la forme des liens externes, le
// portail qualité, et le chevron qui replie le groupe Channels. La huitième —
// les cinq derniers fils d'un dossier — se prouve dans
// `ChatFolderGroup.test.tsx`, avec les dossiers.
//
// Les blocs qui ne sont pas le sujet (version, sélecteur d'espace, cloche,
// thème) sont remplacés par du vide : ils appellent chacun leur action
// serveur, et les monter ici n'aurait rien prouvé de plus sur le menu.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions', () => ({ listApprovalsAction: vi.fn() }));
vi.mock('@/lib/conversation-actions.ts', () => ({ getChatFoldersAction: vi.fn() }));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));
vi.mock('../VersionBadge', () => ({ default: () => null }));
vi.mock('../WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { SIDEBAR_ROW, SIDEBAR_ROW_ACTIVE, SIDEBAR_ROW_IDLE } from '../ui/SidebarRow';

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

async function renderSidebar(channels: string[] = []): Promise<void> {
  await render(
    <ApprovalsProvider initial={[]}>
      <ChatFoldersProvider
        initial={{ channels, running: {}, runningConversationIds: [], externalRuns: 0 }}
      >
        <Sidebar workspaces={[]} />
      </ChatFoldersProvider>
    </ApprovalsProvider>,
  );
}

/** Le lien du menu qui porte ce libellé, quelle que soit sa forme. */
function navLink(label: string): HTMLAnchorElement {
  const el = [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === label);
  if (!el) throw new Error(`no nav link labelled "${label}"`);
  return el;
}

/**
 * Les libellés d'un groupe, DANS L'ORDRE où ils sont rendus.
 *
 * Les dossiers de Channels sont écartés : ils vivent dans le groupe Overview,
 * sous leur lien, mais ce ne sont pas des entrées du menu — ils ont leur propre
 * test (`ChatFolderGroup.test.tsx`).
 */
function groupLabels(section: string): string[] {
  const group = container.querySelector(`[data-testid="nav-group-${section}"]`);
  if (!group) throw new Error(`no group "${section}"`);
  const folders = group.querySelector('[data-testid="chat-folders"]');
  return [...group.querySelectorAll('a')]
    .filter((a) => folders === null || !folders.contains(a))
    .map((a) => a.textContent?.trim() ?? '');
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Un `localStorage` en mémoire.
 *
 * Node 26 fournit le sien, et il est INDISPONIBLE sans `--localstorage-file` :
 * le global vaut `undefined` sous vitest, jsdom ou non. Le composant s'en
 * arrange (tout accès est sous `try`), mais le souvenir du repli, lui, se
 * prouve — d'où ce double, posé pour la durée du fichier.
 */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('les entrées du menu @cap:installer-et-demarrer/ecran', () => {
  it('nomme la racine « Dashboard », et plus « Home »', async () => {
    await renderSidebar();
    expect(navLink('Dashboard').getAttribute('href')).toBe('/');
    expect(() => navLink('Home')).toThrow();
  });

  it('nomme « Workspaces » ce qui vit toujours sur /spaces', async () => {
    await renderSidebar();
    // Le libellé change, la ROUTE ne bouge pas : les liens déjà envoyés et les
    // favoris continuent d'ouvrir la page.
    expect(navLink('Workspaces').getAttribute('href')).toBe('/spaces');
    expect(() => navLink('Spaces')).toThrow();
  });

  it('ouvre « Operate » par le fournisseur de modèles et le ferme par Settings', async () => {
    await renderSidebar();
    expect(groupLabels('Operate')).toEqual([
      'LLM Providers',
      'Automations & Webhooks',
      'Approvals',
      'Logs',
      'Settings',
    ]);
  });

  it('ne laisse plus « LLM Providers » ni « Settings » ailleurs', async () => {
    await renderSidebar();
    expect(groupLabels('Overview')).toEqual(['Dashboard', 'Channels', 'Workspaces', 'Scheduled']);
    expect(groupLabels('About Nodal-Agents')).not.toContain('Settings');
  });

  it('ne propose plus « Code » nulle part dans le rail', async () => {
    await renderSidebar();
    // Les pages /code et /code/[id] existent toujours, et restent
    // atteignables par les liens des pages de run et du dossier MCP. C'est la
    // DESTINATION du menu qui disparaît, en attendant leur fusion dans
    // Workspaces (issue #143).
    expect(() => navLink('Code')).toThrow();
    expect(container.querySelector('a[href="/code"]')).toBeNull();
  });
});

describe('le groupe « About Nodal-Agents » @cap:consulter-l-aide/ecran', () => {
  it('remplace le groupe « Workspace » et garde ses deux liens', async () => {
    await renderSidebar();
    expect(container.querySelector('[data-testid="nav-group-Workspace"]')).toBeNull();
    expect(groupLabels('About Nodal-Agents')).toEqual([
      'Join Discord',
      'Documentation',
      'Quality board',
    ]);
  });

  it('mène au portail public, dans un nouvel onglet', async () => {
    await renderSidebar();
    const portail = navLink('Quality board');
    // L'URL vérifiée au curl le 18/09/2026 : 200, « Nodal-Agents, Quality ».
    expect(portail.getAttribute('href')).toBe('https://kwintspiracy.github.io/nodal-agents/qa/');
    expect(portail.getAttribute('target')).toBe('_blank');
    expect(portail.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('donne au portail la MÊME forme qu’à Documentation : flèche à droite', async () => {
    await renderSidebar();
    for (const label of ['Documentation', 'Quality board']) {
      const row = navLink(label);
      const arrow = row.querySelector('[data-testid="external-arrow"]');
      expect(arrow, `${label} porte une flèche de lien externe`).not.toBeNull();
      expect(row.lastElementChild, `${label} la porte en DERNIER`).toBe(arrow);
    }
  });
});

describe('le bouton « Join Discord » @cap:consulter-l-aide/ecran', () => {
  it('porte le logo Discord à gauche et la flèche à DROITE', async () => {
    await renderSidebar();
    const row = navLink('Join Discord');
    const icone = row.querySelector('[data-testid="nav-leading-icon"]');
    const arrow = row.querySelector('[data-testid="external-arrow"]');
    // La flèche menait la ligne et aucune marque ne la nommait ; elle ferme
    // maintenant la ligne, exactement comme sur « Documentation ».
    expect(row.firstElementChild).toBe(icone);
    expect(row.lastElementChild).toBe(arrow);
    // Et l'icône de tête N'EST PAS la flèche : c'est tout le sujet de la
    // demande. Deux dessins différents, donc deux markups différents.
    const dessin = icone?.querySelector('svg')?.innerHTML ?? '';
    expect(dessin).not.toBe('');
    expect(dessin).not.toBe(arrow?.innerHTML);
  });
});

describe('le chevron du groupe Channels @cap:reprendre-conversation/ecran', () => {
  it('déplie les dossiers par défaut, et les replie au clic', async () => {
    await renderSidebar();
    const caret = container.querySelector('[data-testid="channels-caret"]');
    expect(caret).not.toBeNull();
    expect(caret?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="chat-folders"]')).not.toBeNull();

    await click(caret!);
    expect(caret?.getAttribute('aria-expanded')).toBe('false');
    // Replié, le groupe n'est pas seulement caché : il n'est pas rendu, donc
    // ses lignes ne restent pas dans l'ordre de tabulation.
    expect(container.querySelector('[data-testid="chat-folders"]')).toBeNull();
  });

  it('laisse le nom « Channels » mener à /chat malgré le chevron', async () => {
    await renderSidebar();
    expect(navLink('Channels').getAttribute('href')).toBe('/chat');
  });

  it('se souvient du repli dans ce navigateur', async () => {
    await renderSidebar();
    await click(container.querySelector('[data-testid="channels-caret"]')!);
    expect(localStorage.getItem('nodal.sidebar.channels')).toBe('closed');

    // Un rechargement : la barre relit le choix au montage.
    await act(async () => {
      root.unmount();
    });
    await renderSidebar();
    expect(container.querySelector('[data-testid="chat-folders"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="channels-caret"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

// ─── Une seule forme de ligne (19/09/2026) ───────────────────────────────────

/**
 * Le rail déplié EN ENTIER : une entrée de menu, un lien externe, le bouton
 * Discord, le groupe Channels avec son chevron, un dossier avec le sien, ses
 * fils et son « See all ». Toutes les sortes de ligne du rail, d'un coup.
 */
async function renderTout(): Promise<void> {
  vi.mocked(listFolderThreadsAction).mockResolvedValue({
    ok: true,
    data: {
      telegram: [
        {
          key: 't1',
          title: 'Invoice for March',
          href: '/chat/t1',
          waiting: false,
          running: false,
          unread: false,
        },
      ],
    },
  });
  await renderSidebar(['telegram']);
  await click(container.querySelector('[data-testid="folder-caret-telegram"]')!);
}

/** Toutes les lignes du rail, quelle que soit leur profondeur. */
function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-sidebar-row]')];
}

describe('toutes les lignes du rail ont la MÊME forme @cap:installer-et-demarrer/ecran', () => {
  it('rend la même classe de ligne pour chacune, quelle que soit sa profondeur', async () => {
    await renderTout();

    // Le rail déplié porte bien les cinq sortes de ligne : sans elles, la
    // comparaison ci-dessous ne prouverait rien.
    expect(container.querySelector('[data-testid="inbox-folder-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-thread-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-see-all-telegram"]')).not.toBeNull();
    expect(rows().length).toBeGreaterThan(20);

    // UNE comparaison, pas cinq assertions : chaque ligne est la forme
    // commune, suivie de son état et de rien d'autre. Marges, hauteur, rayon,
    // fond de survol, fond actif — tout vient du même endroit.
    const formes = new Set(rows().map((r) => r.className));
    const attendues = new Set([
      `${SIDEBAR_ROW} ${SIDEBAR_ROW_IDLE}`,
      `${SIDEBAR_ROW} ${SIDEBAR_ROW_ACTIVE}`,
      // La seule exception est une COULEUR de marque, pas une forme : le bleu
      // Discord remplace le fond d'état, le reste de la ligne est identique.
      `${SIDEBAR_ROW} bg-[#5865F2] text-white hover:brightness-110`,
    ]);
    for (const forme of formes) {
      expect(attendues.has(forme), `forme de ligne inattendue : « ${forme} »`).toBe(true);
    }
  });

  it('fait porter le survol à la LIGNE, pas au lien — donc aussi sous le chevron', async () => {
    await renderTout();
    for (const testId of ['channels-caret', 'folder-caret-telegram']) {
      const caret = container.querySelector(`[data-testid="${testId}"]`);
      const ligne = caret?.closest('[data-sidebar-row]');
      // Le chevron est DANS la ligne : le fond de survol de celle-ci court
      // donc sous lui, au lieu de s'arrêter au bord du lien.
      expect(ligne, `${testId} vit dans une ligne`).not.toBeNull();
      expect(ligne?.className).toContain('hover:bg-hover');
      // Et il ne navigue pas : c'est un bouton, pas un lien.
      expect(caret?.tagName).toBe('BUTTON');
      expect(caret?.closest('a')).toBeNull();
    }
  });

  it('aligne tout libellé à GAUCHE, qu’une ligne soit un lien ou un bouton', async () => {
    await renderTout();
    // Le contenu d'une ligne : son lien, ou son bouton quand elle ne mène nulle
    // part. C'est le premier enfant, le chevron venant après.
    const contenus = rows().map((r) => r.firstElementChild);

    // Les DEUX natures sont là — sans elles, la comparaison ne prouverait rien.
    expect(contenus.some((el) => el?.tagName === 'BUTTON')).toBe(true);
    expect(contenus.some((el) => el?.tagName === 'A')).toBe(true);

    // Un `<button>` natif centre son texte, et le reset de Tailwind ne touche
    // pas `text-align` : les lignes de dossier, devenues boutons, écrivaient
    // leur nom au milieu du rail pendant que les liens restaient à gauche.
    for (const el of contenus) {
      expect(el?.className, `une ligne ${el?.tagName} aligne son libellé`).toContain('text-left');
    }
  });
});

describe('les icônes du rail se distinguent @cap:reprendre-conversation/ecran', () => {
  it('ne donne pas la même icône à « Channels » et à « Nodal chats »', async () => {
    await renderTout();
    const groupe = navLink('Channels').querySelector('[data-testid="nav-leading-icon"] svg');
    const dossier = container
      .querySelector('[data-testid="inbox-folder-dashboard"]')
      ?.querySelector('svg');
    expect(groupe?.innerHTML).not.toBe('');
    expect(dossier?.innerHTML).not.toBe('');
    // Les deux portaient la même bulle : la ligne parente et son premier
    // enfant étaient indiscernables l'une de l'autre.
    expect(groupe?.innerHTML).not.toBe(dossier?.innerHTML);
  });
});
