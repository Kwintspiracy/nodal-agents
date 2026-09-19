// Sidebar.test.tsx — la barre latérale À L'ÉCRAN, rail et panneau (#230).
//
// La colonne unique de 0.8.11 est devenue un RAIL de trois destinations et un
// PANNEAU pour celle qui est active (décision du propriétaire, 19/09/2026,
// planche « Sidebar propositions · 4a »). Ce fichier prouve les six choses que
// cette bascule pouvait casser sans qu'on le voie :
//
//   1. les entrées sont les MÊMES qu'avant, réparties en trois panneaux ;
//   2. la destination active se DÉDUIT de la route, et rien d'autre ;
//   3. un canal n'a de dossier que branché (#135) ;
//   4. un dossier se plie et se déplie, et seul « See all » navigue (#206) ;
//   5. le point de non-lu est toujours rendu, dans les dossiers ET dans la
//      nouvelle section « Recent » (#209) ;
//   6. un titre long se COUPE, il n'élargit pas la colonne.
//
// Les blocs qui ne sont pas le sujet (version, sélecteur d'espace, cloche,
// thème) sont remplacés par du vide : ils appellent chacun leur action serveur,
// et les monter ici n'aurait rien prouvé de plus sur le menu.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let pathname = '/agents';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions', () => ({ listApprovalsAction: vi.fn() }));
vi.mock('@/lib/conversation-actions.ts', () => ({ getChatFoldersAction: vi.fn() }));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));
vi.mock('@/lib/recent-threads-actions.ts', () => ({ listRecentThreadsAction: vi.fn() }));
vi.mock('../VersionBadge', () => ({ default: () => null }));
vi.mock('../WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listRecentThreadsAction } from '@/lib/recent-threads-actions.ts';
import { SIDEBAR_ROW, SIDEBAR_ROW_ACTIVE, SIDEBAR_ROW_IDLE } from '../ui/SidebarRow';
import { RAIL_CELL, RAIL_CELL_ACTIVE, RAIL_CELL_IDLE } from '../ui/RailCell';
import type { FolderThread } from '@/lib/chat-folders.ts';

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

/** Démonte le rendu courant — pour en refaire un dans le MÊME cas de test. */
async function remonter(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
}

/** Le lien du menu qui porte ce libellé, quelle que soit sa forme. */
function navLink(label: string): HTMLAnchorElement {
  const el = [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === label);
  if (!el) throw new Error(`no nav link labelled "${label}"`);
  return el;
}

/** Une case du rail, par la destination qu'elle porte. */
function railCell(key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="rail-${key}"]`);
  if (!el) throw new Error(`no rail cell "${key}"`);
  return el;
}

/**
 * Les libellés d'un groupe du panneau, DANS L'ORDRE où ils sont rendus.
 *
 * Un groupe ne contient que des entrées de menu : les dossiers de canaux et les
 * fils récents vivent hors des groupes, dans le panneau Talk, et ont leurs
 * propres cas.
 */
function groupLabels(section: string): string[] {
  const group = container.querySelector(`[data-testid="nav-group-${section}"]`);
  if (!group) throw new Error(`no group "${section}"`);
  return [...group.querySelectorAll('a')].map((a) => a.textContent?.trim() ?? '');
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Un fil, réduit à ce que le menu en rend. */
function thread(over: Partial<FolderThread> & { key: string; title: string }): FolderThread {
  return {
    href: `/chat/${over.key}`,
    waiting: false,
    running: false,
    unread: false,
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  pathname = '/agents';
  vi.mocked(listRecentThreadsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: {} });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

// ─── 1. Le rail, et sa destination active ────────────────────────────────────

describe('le rail porte trois destinations @cap:installer-et-demarrer/ecran', () => {
  it('rend Talk, Build et Run, puis Settings et Help', async () => {
    await renderSidebar();
    for (const key of ['talk', 'build', 'run', 'settings', 'help']) {
      expect(railCell(key), `le rail porte « ${key} »`).not.toBeNull();
    }
    expect(railCell('talk').textContent?.trim()).toBe('Talk');
    expect(railCell('build').textContent?.trim()).toBe('Build');
    expect(railCell('run').textContent?.trim()).toBe('Run');
  });

  it('donne la MÊME forme aux cases, active ou non', async () => {
    await renderSidebar();
    const formes = new Set(
      ['talk', 'build', 'run', 'settings', 'help'].map((k) => railCell(k).className),
    );
    const attendues = new Set([
      `${RAIL_CELL} ${RAIL_CELL_IDLE}`,
      `${RAIL_CELL} ${RAIL_CELL_ACTIVE}`,
    ]);
    // La route est /agents : Build est active, les autres non. Les DEUX états
    // sont donc là — sans cela, la comparaison ne prouverait rien.
    expect(formes.has(`${RAIL_CELL} ${RAIL_CELL_ACTIVE}`)).toBe(true);
    expect(formes.has(`${RAIL_CELL} ${RAIL_CELL_IDLE}`)).toBe(true);
    for (const forme of formes) {
      expect(attendues.has(forme), `forme de case inattendue : « ${forme} »`).toBe(true);
    }
  });
});

describe('la destination active suit la route @cap:installer-et-demarrer/ecran', () => {
  /** Quelle case porte `aria-current="page"` ? Une seule doit la porter. */
  function destinationActive(): string {
    const actives = [...container.querySelectorAll('[data-testid^="rail-"]')].filter(
      (el) => el.getAttribute('aria-current') === 'page',
    );
    expect(actives.length, 'une seule case du rail est la page courante').toBe(1);
    return actives[0]?.getAttribute('data-testid')?.replace('rail-', '') ?? '';
  }

  const cas: ReadonlyArray<readonly [string, string, string]> = [
    ['/agents', 'build', 'Build'],
    ['/memories', 'build', 'Build'],
    ['/mcp', 'build', 'Build'],
    ['/chat', 'talk', 'Talk'],
    ['/chat/abc', 'talk', 'Talk'],
    ['/', 'run', 'Run'],
    ['/logs', 'run', 'Run'],
    ['/spaces', 'run', 'Run'],
    ['/scheduled', 'run', 'Run'],
    // Une page de run n'a pas d'entrée dans le panneau, mais elle allume bien
    // une destination : un rail sans case active se lirait comme cassé.
    ['/jobs/j1', 'run', 'Run'],
  ];

  for (const [route, attendue, titre] of cas) {
    it(`allume « ${attendue} » sur ${route}`, async () => {
      pathname = route;
      await renderSidebar();
      expect(destinationActive()).toBe(attendue);
      // Et le PANNEAU montre la même destination : son titre le dit.
      expect(container.querySelector('[data-testid="sidebar-panel"] h2')?.textContent?.trim()).toBe(
        titre,
      );
    });
  }

  it('allume Settings sur /settings, sans allumer aucune des trois', async () => {
    pathname = '/settings';
    await renderSidebar();
    expect(railCell('settings').getAttribute('aria-current')).toBe('page');
    for (const key of ['talk', 'build', 'run']) {
      expect(railCell(key).getAttribute('aria-current'), `${key} n'est pas la page`).toBeNull();
    }
    // Le panneau doit bien montrer quelque chose : Run, qui porte le tableau de
    // bord, est le repli — et il est le même pour tout le monde, ce qu'une
    // « dernière destination visitée » n'aurait pas été.
    expect(
      container.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('aria-label'),
    ).toBe('Run');
  });
});

// ─── 2. Les entrées, réparties en trois panneaux ─────────────────────────────

describe('les entrées de 0.8.11, réparties en trois @cap:installer-et-demarrer/ecran', () => {
  it('range Build en deux blocs : ce qu’on monte, puis ce qu’on y branche', async () => {
    pathname = '/agents';
    await renderSidebar();
    expect(groupLabels('Agents')).toEqual(['Agents', 'Skills', 'Learned Skills', 'Memory']);
    expect(groupLabels('Connect')).toEqual(['API Connectors', 'MCP Connectors', 'Credentials']);
  });

  it('range Run en trois blocs, et n’y perd ni Scheduled ni LLM Providers', async () => {
    pathname = '/';
    await renderSidebar();
    expect(groupLabels('Monitor')).toEqual(['Dashboard', 'Workspaces', 'Approvals', 'Logs']);
    // « Scheduled » n'est dans aucune liste de l'issue, et ce n'est pourtant
    // pas /automations : celui-ci ÉDITE les automatisations, celui-là liste
    // leurs runs. Le retirer aurait supprimé une destination du produit.
    expect(groupLabels('Automate')).toEqual(['Automations & Webhooks', 'Scheduled']);
    expect(groupLabels('Models')).toEqual(['LLM Providers']);
  });

  it('nomme la racine « Dashboard », et « Workspaces » ce qui vit sur /spaces', async () => {
    pathname = '/';
    await renderSidebar();
    expect(navLink('Dashboard').getAttribute('href')).toBe('/');
    expect(() => navLink('Home')).toThrow();
    // Le libellé change, la ROUTE ne bouge pas : les liens déjà envoyés et les
    // favoris continuent d'ouvrir la page.
    expect(navLink('Workspaces').getAttribute('href')).toBe('/spaces');
    expect(() => navLink('Spaces')).toThrow();
  });

  it('ne propose « Code » dans aucun des trois panneaux', async () => {
    for (const route of ['/', '/agents', '/chat']) {
      pathname = route;
      await renderSidebar();
      // Les pages /code et /code/[id] existent toujours et restent
      // atteignables par les liens des pages de run et du dossier MCP. C'est la
      // DESTINATION du menu qui n'existe pas (issue #143).
      expect(container.querySelector('a[href="/code"]'), route).toBeNull();
      await remonter();
    }
    // `afterEach` démonte : on rend une dernière fois pour qu'il ait de quoi.
    await renderSidebar();
  });

  it('marque l’entrée du panneau où l’on se trouve, et elle seule', async () => {
    pathname = '/skills';
    await renderSidebar();
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    const actives = [...(panneau?.querySelectorAll('[data-sidebar-row]') ?? [])].filter((r) =>
      r.className.includes(SIDEBAR_ROW_ACTIVE),
    );
    expect(actives.length).toBe(1);
    expect(actives[0]?.textContent?.trim()).toBe('Skills');
  });
});

// ─── 3. Le panneau Talk : canaux, fils récents, non-lu ───────────────────────

/** Le panneau Talk, avec un dossier Telegram qui déplie un fil non lu. */
async function renderTalk(channels: string[] = ['telegram']): Promise<void> {
  vi.mocked(listFolderThreadsAction).mockResolvedValue({
    ok: true,
    data: {
      telegram: [thread({ key: 't1', title: 'Invoice for March', unread: true })],
    },
  });
  vi.mocked(listRecentThreadsAction).mockResolvedValue({
    ok: true,
    data: [
      thread({ key: 'r1', title: 'Recipes' }),
      thread({
        key: 'r2',
        title: 'Crée-moi une application de suivi de candidatures assez simple',
        unread: true,
      }),
    ],
  });
  pathname = '/chat';
  await renderSidebar(channels);
}

describe('le panneau Talk garde les dossiers de 0.8.11 @cap:reprendre-conversation/ecran', () => {
  it('n’affiche un canal que lorsqu’il est branché', async () => {
    await renderTalk([]);
    // « Nodal chats » est une destination permanente : elle est toujours là.
    expect(container.querySelector('[data-testid="inbox-folder-dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-folder-discord"]')).toBeNull();
    expect(container.querySelector('[data-testid="inbox-folder-whatsapp"]')).toBeNull();

    await remonter();
    await renderTalk(['discord', 'whatsapp']);
    expect(container.querySelector('[data-testid="inbox-folder-discord"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-folder-whatsapp"]')).not.toBeNull();
  });

  it('plie et déplie un dossier au clic sur sa ligne', async () => {
    await renderTalk();
    const dossier = container.querySelector('[data-testid="inbox-folder-telegram"]')!;
    expect(dossier.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();

    await click(dossier);
    expect(dossier.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="folder-thread-telegram"]')?.textContent,
    ).toContain('Invoice for March');

    await click(dossier);
    // Replié, le sous-menu n'est pas seulement caché : il n'est pas rendu, donc
    // ses lignes ne restent pas dans l'ordre de tabulation.
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();
  });

  it('ne fait naviguer QUE « See all », jamais le nom du dossier', async () => {
    await renderTalk();
    const dossier = container.querySelector('[data-testid="inbox-folder-telegram"]')!;
    // Le nom d'un dossier est un BOUTON : il plie, il ne mène nulle part.
    expect(dossier.tagName).toBe('BUTTON');
    expect(dossier.closest('a')).toBeNull();

    await click(dossier);
    const seeAll = container.querySelector('[data-testid="folder-see-all-telegram"]');
    expect(seeAll?.tagName).toBe('A');
    expect(seeAll?.getAttribute('href')).toBe('/chat?folder=telegram');
  });
});

describe('la section « Recent » du panneau Talk @cap:reprendre-conversation/ecran', () => {
  it('liste les derniers fils tous canaux confondus, puis « See all »', async () => {
    await renderTalk();
    const lignes = [...container.querySelectorAll('[data-testid="recent-thread"]')];
    expect(lignes.map((l) => l.getAttribute('href'))).toEqual(['/chat/r1', '/chat/r2']);
    const seeAll = container.querySelector('[data-testid="recent-see-all"]');
    expect(seeAll?.tagName).toBe('A');
    expect(seeAll?.getAttribute('href')).toBe('/chat');
    expect(seeAll?.querySelector('[data-testid="see-all-arrow"]')).not.toBeNull();
  });

  it('dit ce qu’une lecture en échec a répondu, au lieu de se taire', async () => {
    vi.mocked(listRecentThreadsAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to load the recent threads',
    });
    pathname = '/chat';
    await renderSidebar();
    expect(container.querySelector('[data-testid="recent-threads"]')?.textContent).toContain(
      'Failed to load the recent threads',
    );
    // Et AUCUNE ligne : une section vide et une section illisible ne se
    // ressemblent pas (invariant #4).
    expect(container.querySelector('[data-testid="recent-thread"]')).toBeNull();
  });
});

describe('le point de non-lu survit au rail @cap:reprendre-conversation/ecran', () => {
  it('rend le point sur un fil de dossier ET sur un fil récent (#209)', async () => {
    await renderTalk();
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);

    const fil = container.querySelector('[data-testid="folder-thread-telegram"]');
    expect(fil?.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls')).toBe(
      'yes',
    );

    const recents = [...container.querySelectorAll('[data-testid="recent-thread"]')];
    const appels = recents.map((l) =>
      l.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls'),
    );
    // Le premier est lu, le second ne l'est pas : le point dit les deux, et il
    // les dit différemment.
    expect(appels).toEqual(['no', 'yes']);
  });
});

// ─── 4. La largeur du panneau ne bouge pas ───────────────────────────────────

describe('un titre long ne pousse pas la colonne @cap:reprendre-conversation/ecran', () => {
  it('coupe le titre d’un fil au lieu d’élargir le panneau', async () => {
    await renderTalk();
    const long = [...container.querySelectorAll('[data-testid="recent-thread"]')].find((l) =>
      l.textContent?.includes('suivi de candidatures'),
    );
    expect(long, 'le fil au titre long est rendu').not.toBeUndefined();
    // Le libellé porte `truncate` : il se coupe dans la place qu'il a.
    const libelle = [...(long?.querySelectorAll('span') ?? [])].find((s) =>
      s.className.includes('flex-1'),
    );
    expect(libelle?.className).toContain('truncate');

    // Et la colonne, elle, est taillée dans une mesure FIXE : `--panel-w`. Une
    // largeur qui suivrait le contenu décalerait toute la page en ouvrant un
    // dossier, et la gouttière que le contenu garde (`--sidebar-w`) serait
    // fausse une ligne plus tard.
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    expect(panneau?.className).toContain('lg:w-[var(--panel-w)]');
    expect(panneau?.className).toContain('min-w-0');
  });
});

// ─── 5. Une seule forme de ligne, dans tout le panneau ───────────────────────

describe('toutes les lignes du panneau ont la MÊME forme @cap:installer-et-demarrer/ecran', () => {
  it('rend la même classe de ligne pour chacune, quelle que soit sa profondeur', async () => {
    await renderTalk();
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);

    // Le panneau déplié porte bien les quatre sortes de ligne : sans elles, la
    // comparaison ci-dessous ne prouverait rien.
    expect(container.querySelector('[data-testid="inbox-folder-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-thread-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-see-all-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recent-thread"]')).not.toBeNull();

    // Deux dossiers, le fil déplié, son « See all », deux fils récents et le
    // « See all » de la section : sept lignes, toutes sortes confondues.
    const lignes = [...container.querySelectorAll<HTMLElement>('[data-sidebar-row]')];
    expect(lignes.length).toBe(7);

    // UNE comparaison, pas quatre assertions : chaque ligne est la forme
    // commune, suivie de son état et de rien d'autre. Marges, hauteur, rayon,
    // fond de survol, fond actif — tout vient du même endroit.
    const attendues = new Set([
      `${SIDEBAR_ROW} ${SIDEBAR_ROW_IDLE}`,
      `${SIDEBAR_ROW} ${SIDEBAR_ROW_ACTIVE}`,
    ]);
    for (const forme of new Set(lignes.map((l) => l.className))) {
      expect(attendues.has(forme), `forme de ligne inattendue : « ${forme} »`).toBe(true);
    }
  });
});

// ─── 6. Help : les trois liens du produit, tous dehors ───────────────────────

describe('la carte « Help » du rail @cap:consulter-l-aide/ecran', () => {
  it('reste fermée tant qu’on ne l’ouvre pas', async () => {
    await renderSidebar();
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
    expect(railCell('help').getAttribute('aria-expanded')).toBe('false');
  });

  it('garde les trois liens externes de 0.8.11, chacun dans un nouvel onglet', async () => {
    await renderSidebar();
    await click(railCell('help'));
    const carte = container.querySelector('[data-testid="rail-popover"]');
    expect(carte?.getAttribute('aria-label')).toBe('Help');

    const liens = [...(carte?.querySelectorAll('a') ?? [])];
    expect(liens.map((a) => a.textContent?.trim())).toEqual([
      'Documentation',
      'Join Discord',
      'Quality board',
    ]);
    for (const lien of liens) {
      expect(lien.getAttribute('target'), lien.textContent ?? '').toBe('_blank');
      expect(lien.getAttribute('rel'), lien.textContent ?? '').toBe('noopener noreferrer');
      // La flèche dit qu'on quitte l'application, et elle FERME la ligne.
      const fleche = lien.querySelector('[data-testid="external-arrow"]');
      expect(fleche, lien.textContent ?? '').not.toBeNull();
      expect(lien.lastElementChild, lien.textContent ?? '').toBe(fleche);
    }
  });

  it('mène au portail public vérifié le 18/09/2026', async () => {
    await renderSidebar();
    await click(railCell('help'));
    expect(navLink('Quality board').getAttribute('href')).toBe(
      'https://kwintspiracy.github.io/nodal-agents/qa/',
    );
  });

  it('se referme à Échap', async () => {
    await renderSidebar();
    await click(railCell('help'));
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
  });
});

describe('le compte au bas du rail @cap:se-connecter/ecran', () => {
  it('n’ouvre le bloc de compte qu’au clic, et il vient du serveur', async () => {
    await render(
      <ApprovalsProvider initial={[]}>
        <ChatFoldersProvider
          initial={{ channels: [], running: {}, runningConversationIds: [], externalRuns: 0 }}
        >
          <Sidebar workspaces={[]} userMenu={<p>quentin@example.com</p>} />
        </ChatFoldersProvider>
      </ApprovalsProvider>,
    );
    expect(container.querySelector('[data-testid="user-menu"]')).toBeNull();

    await click(container.querySelector('[data-testid="rail-account"]')!);
    expect(container.querySelector('[data-testid="user-menu"]')?.textContent).toContain(
      'quentin@example.com',
    );

    // L'avatar n'invente AUCUNE initiale : le rail ne sait pas qui est
    // connecté, et une lettre choisie au hasard serait un fait que rien ne
    // vérifie (invariant #4).
    expect(container.querySelector('[data-testid="rail-account"]')?.textContent?.trim()).toBe('');
  });
});
