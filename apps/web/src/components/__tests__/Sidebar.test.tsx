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
vi.mock('@/lib/conversation-actions.ts', () => ({
  getChatFoldersAction: vi.fn(),
  listRecentThreadReadsAction: vi.fn(),
}));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));
vi.mock('@/lib/project-actions.ts', () => ({ listSidebarProjectsAction: vi.fn() }));
vi.mock('../VersionBadge', () => ({ default: () => null }));
vi.mock('../WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider, type PendingApproval } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listApprovalsAction } from '@/lib/actions';
import {
  getChatFoldersAction,
  listRecentThreadReadsAction,
  type FolderConversationRead,
} from '@/lib/conversation-actions.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import {
  SIDEBAR_ROW_BASE,
  SIDEBAR_ROW_H,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_IDLE,
} from '../ui/SidebarRow';
import { RAIL_CELL, RAIL_CELL_ACTIVE, RAIL_CELL_IDLE } from '../ui/RailCell';
import { SIDEBAR_POLL_MS } from '@/lib/use-polling';
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

/** Deux espaces de travail : le compte de la ligne « Workspaces » vaut 2. */
const ESPACES = [
  { id: 'w1', name: 'Local', slug: 'local', icon: null, active: true },
  { id: 'w2', name: 'Client', slug: 'client', icon: null, active: false },
] as unknown as Parameters<typeof Sidebar>[0]['workspaces'];

async function renderSidebar(
  channels: string[] = [],
  attentes: PendingApproval[] = [],
): Promise<void> {
  await render(
    <ApprovalsProvider initial={attentes}>
      <ChatFoldersProvider
        initial={{ channels, running: {}, runningConversationIds: [], externalRuns: 0 }}
      >
        <Sidebar workspaces={ESPACES} />
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

/** Un fil d'un sous-menu de dossier, réduit à ce que le menu en rend. */
function thread(over: Partial<FolderThread> & { key: string; title: string }): FolderThread {
  return {
    href: `/chat/${over.key}`,
    waiting: false,
    running: false,
    unread: false,
    ...over,
  };
}

/**
 * Une ligne de « Recent » telle que la LECTURE la rend.
 *
 * Trois champs, et c'est tout : depuis la passe 1 de la revue, la section ne
 * lit que les fils. Ce qui ATTEND et ce qui TOURNE vient des contextes de la
 * page, que les deux providers relisent déjà.
 */
function recent(id: string, title: string, unread = false): FolderConversationRead {
  return { id, title, unread };
}

beforeEach(() => {
  document.body.innerHTML = '';
  pathname = '/agents';
  vi.mocked(listRecentThreadReadsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: [] });
  // LES DEUX PROVIDERS VOISINS RÉPONDENT, MÊME SI AUCUN TEST NE LES REGARDE.
  // Ils posent chacun un `setInterval` de 15 s ; dès qu'un test fait tourner
  // l'horloge, leurs actions partent aussi. Sans valeur de retour, elles
  // rendent `undefined`, et le `result.ok` du provider lève une rejection non
  // rattrapée qui fait rougir la suite ENTIÈRE sans qu'aucun test n'échoue
  // (le piège que la CI de la PR #223 a déjà attrapé une fois).
  vi.mocked(listApprovalsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(getChatFoldersAction).mockResolvedValue({
    ok: true,
    data: { channels: [], running: {}, runningConversationIds: [], externalRuns: 0 },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

// ─── 1. Le rail, et sa destination active ────────────────────────────────────

describe('le rail porte trois destinations @cap:installer-et-demarrer/ecran', () => {
  it('rend Work, Agent, Run et Approvals, puis Settings et Help', async () => {
    await renderSidebar();
    for (const key of ['work', 'agent', 'run', 'approvals', 'settings', 'help']) {
      expect(railCell(key), `le rail porte « ${key} »`).not.toBeNull();
    }
    // Les noms du 19/09/2026 : « Work » pour l'endroit où l'on travaille,
    // « Agent » au singulier parce qu'on en règle un à la fois.
    expect(railCell('work').textContent?.trim()).toBe('Work');
    expect(railCell('agent').textContent?.trim()).toBe('Agent');
    expect(railCell('run').textContent?.trim()).toBe('Run');
    expect(() => navLink('Talk')).toThrow();
    expect(() => navLink('Build')).toThrow();
  });

  it('donne la MÊME forme aux cases, active ou non', async () => {
    await renderSidebar();
    const formes = new Set(
      ['work', 'agent', 'run', 'settings', 'help'].map((k) => railCell(k).className),
    );
    const attendues = new Set([
      `relative ${RAIL_CELL} ${RAIL_CELL_IDLE}`,
      `relative ${RAIL_CELL} ${RAIL_CELL_ACTIVE}`,
    ]);
    // La route est /agents : Agent est active, les autres non. Les DEUX états
    // sont donc là — sans cela, la comparaison ne prouverait rien.
    expect(formes.has(`relative ${RAIL_CELL} ${RAIL_CELL_ACTIVE}`)).toBe(true);
    expect(formes.has(`relative ${RAIL_CELL} ${RAIL_CELL_IDLE}`)).toBe(true);
    for (const forme of formes) {
      expect(attendues.has(forme), `forme de case inattendue : « ${forme} »`).toBe(true);
    }
  });
});

// ─── Approvals : une CASE du rail, et sa pastille ────────────────────────────
//
// Elle vivait dans le panneau Run : ce qui attendait une réponse ne se voyait
// donc qu'en allant dans Run. Sur le rail, son nombre est visible d'où que
// l'on soit — c'est le seul de la barre qu'une personne puisse faire tomber à
// zéro en répondant.

describe('la case Approvals du rail @cap:approuver-une-action/ecran', () => {
  /** Une demande en attente, réduite à ce que le contexte en garde. */
  function attente(n: number): PendingApproval[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      jobId: `j${i}`,
      toolName: 'send_message',
      agentName: null,
      toolInput: {},
      requestedAt: null,
      jobChannel: 'dashboard',
      conversationChannel: 'dashboard',
    }));
  }

  it('mène à /approvals, et s’allume quand on y est', async () => {
    pathname = '/approvals';
    await renderSidebar();
    expect(railCell('approvals').getAttribute('href')).toBe('/approvals');
    expect(railCell('approvals').getAttribute('aria-current')).toBe('page');
    // Approvals n'est PAS une destination : aucune des trois ne s'allume, et
    // le panneau montre le repli, comme sur `/settings`.
    for (const key of ['work', 'agent', 'run']) {
      expect(railCell(key).getAttribute('aria-current'), key).toBeNull();
    }
    expect(
      container.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('aria-label'),
    ).toBe('Run');
  });

  it('porte le NOMBRE de demandes en attente', async () => {
    // Mutation vérifiée : `pill={approvalsCount}` remplacé par `pill={0}`
    // dans `SidebarRail` → ce cas rougit, la case n'écrit plus rien.
    await renderSidebar([], attente(3));
    expect(railCell('approvals').textContent?.trim()).toBe('Approvals3');
  });

  it('n’écrit RIEN à zéro', async () => {
    await renderSidebar([], []);
    // Une pastille « 0 » demande d'être lue pour apprendre qu'il n'y a rien à
    // faire : à zéro, la case ne porte que son nom.
    expect(railCell('approvals').textContent?.trim()).toBe('Approvals');
  });

  it('DIT ce que le nombre compte, au lieu de le coller au libellé', async () => {
    // Sans nom accessible, un lecteur d'écran annonce « Approvals 3 » : le
    // libellé et le chiffre collés, sans un mot pour dire ce qu'il compte.
    //
    // Mutation vérifiée : l'`aria-label` retiré de `RailCell` → ce cas rougit.
    await renderSidebar([], attente(3));
    expect(railCell('approvals').getAttribute('aria-label')).toBe('Approvals, 3 pending');
  });

  it('ne pose AUCUN nom accessible quand il n’y a rien à compter', async () => {
    await renderSidebar([], []);
    // Le texte de la case suffit alors, et un `aria-label` qui le répète
    // masquerait le libellé au lieu de l'expliquer.
    expect(railCell('approvals').getAttribute('aria-label')).toBeNull();
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
    ['/agents', 'agent', 'Agent'],
    ['/memories', 'agent', 'Agent'],
    ['/mcp', 'agent', 'Agent'],
    ['/llm-providers', 'agent', 'Agent'],
    ['/chat', 'work', 'Work'],
    ['/chat/abc', 'work', 'Work'],
    // Les espaces de travail ouvrent Work depuis le 19/09 : leur ligne est
    // dans son panneau, et la case doit s'allumer avec elle.
    ['/spaces', 'work', 'Work'],
    // La racine rend un fil vide depuis l'issue #248 : c'est Work, pas Run.
    ['/', 'work', 'Work'],
    ['/dashboard', 'run', 'Run'],
    ['/logs', 'run', 'Run'],
    ['/automations', 'run', 'Run'],
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
    for (const key of ['work', 'agent', 'run']) {
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
  it('range Agent en deux blocs : ce qu’on monte, puis ce qu’on y branche', async () => {
    pathname = '/agents';
    await renderSidebar();
    expect(groupLabels('Agents')).toEqual(['Agents', 'Skills', 'Learned Skills', 'Memory']);
    // « LLM Providers » ferme CONNECT depuis les planches du 19/09/2026 : il a
    // vécu dans Run sur le texte de l'issue, et le propriétaire l'a redessiné
    // ici, avec ce qu'on branche au produit.
    expect(groupLabels('Connect')).toEqual([
      'API Connectors',
      'MCP Connectors',
      'Credentials',
      'LLM Providers',
    ]);
  });

  it('range Run en DEUX blocs, sans Workspaces ni Approvals', async () => {
    pathname = '/dashboard';
    await renderSidebar();
    // Les deux sont PARTIES le 19/09, et aucune n'a disparu du produit :
    // Workspaces ouvre le panneau Work, Approvals est une case du rail.
    expect(groupLabels('Monitor')).toEqual(['Dashboard', 'Logs']);
    expect(groupLabels('Automate')).toEqual(['Automations & Webhooks']);
    expect(container.querySelector('[data-testid="nav-group-Models"]')).toBeNull();
  });

  it('ouvre le panneau Work par son dossier d’espaces de travail', async () => {
    pathname = '/chat';
    await renderSidebar();
    const dossier = container.querySelector('[data-testid="inbox-folder-workspaces"]');
    expect(dossier, 'le panneau Work porte le dossier Workspaces').not.toBeNull();
    // Il OUVRE le panneau : son dossier précède ceux des canaux, parce qu'on
    // choisit d'abord OÙ l'on travaille.
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    const dossiers = [...(panneau?.querySelectorAll('[data-testid^="inbox-folder-"]') ?? [])];
    expect(dossiers[0]?.getAttribute('data-testid')).toBe('inbox-folder-workspaces');
  });

  it('ne propose « Scheduled » dans aucun des trois panneaux', async () => {
    for (const route of ['/', '/agents', '/chat']) {
      pathname = route;
      await renderSidebar();
      // La page /scheduled disparaît (#202, PR #224) : les runs d'une
      // automatisation se lisent sur SA page, et la route redirige vers
      // /automations. Le menu ne doit donc plus y mener — ni par un libellé,
      // ni par une adresse.
      expect(() => navLink('Scheduled'), route).toThrow();
      expect(container.querySelector('a[href="/scheduled"]'), route).toBeNull();
      await remonter();
    }
    // `afterEach` démonte : on rend une dernière fois pour qu'il ait de quoi.
    await renderSidebar();
  });

  it('mène « Dashboard » à /dashboard, et jamais la racine', async () => {
    pathname = '/dashboard';
    await renderSidebar();
    // Le tableau de bord a DÉMÉNAGÉ (issue #248) : la racine rend un fil vide,
    // et le lien du menu doit suivre, sinon il ramène à l'écran de départ.
    expect(navLink('Dashboard').getAttribute('href')).toBe('/dashboard');
    // Le PANNEAU ne mène plus à la racine. Le rail, si : c'est l'adresse de
    // Work depuis que `/` rend un fil vide.
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    expect(panneau?.querySelector('a[href="/"]')).toBeNull();
    expect(railCell('work').getAttribute('href')).toBe('/');
    expect(() => navLink('Home')).toThrow();
    expect(() => navLink('Spaces')).toThrow();
  });

  it('la case Run du rail MÈNE au tableau de bord, pas à la racine', async () => {
    pathname = '/logs';
    await renderSidebar();
    // Une case du rail est un LIEN. Tant que `/` était le tableau de bord, Run
    // y menait juste ; depuis #248 la racine rend un fil vide, et cliquer Run
    // emmenait donc sur Work, qui s'allumait à sa place. Chaque case mène chez
    // elle, et les deux sont vérifiées ensemble : les confondre est justement
    // la faute qu'on vient de corriger.
    expect(railCell('run').getAttribute('href')).toBe('/dashboard');
    expect(railCell('work').getAttribute('href')).toBe('/');
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

/**
 * Le panneau Work, avec un dossier Telegram qui déplie `fils` fils — le
 * premier non lu.
 *
 * Le NOMBRE compte : la lecture en demande un de plus que le menu n'en
 * dessine, et c'est ce qui décide si « See all » s'affiche.
 */
async function renderTalk(channels: string[] = ['telegram'], fils = 1): Promise<void> {
  vi.mocked(listFolderThreadsAction).mockResolvedValue({
    ok: true,
    data: {
      telegram: Array.from({ length: fils }, (_, i) =>
        thread({ key: `t${i + 1}`, title: `Invoice ${i + 1}`, unread: i === 0 }),
      ),
    },
  });
  vi.mocked(listRecentThreadReadsAction).mockResolvedValue({
    ok: true,
    data: [
      recent('r1', 'Recipes'),
      recent('r2', 'Crée-moi une application de suivi de candidatures assez simple', true),
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
    ).toContain('Invoice 1');

    await click(dossier);
    // Replié, le sous-menu n'est pas seulement caché : il n'est pas rendu, donc
    // ses lignes ne restent pas dans l'ordre de tabulation.
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();
  });

  it('ne fait naviguer QUE « See all », jamais le nom du dossier', async () => {
    // Onze fils : il y en a plus que le menu n'en dessine, donc « See all ».
    await renderTalk(['telegram'], 11);
    const dossier = container.querySelector('[data-testid="inbox-folder-telegram"]')!;
    // Le nom d'un dossier est un BOUTON : il plie, il ne mène nulle part.
    expect(dossier.tagName).toBe('BUTTON');
    expect(dossier.closest('a')).toBeNull();

    await click(dossier);
    const seeAll = container.querySelector('[data-testid="folder-see-all-telegram"]');
    expect(seeAll?.tagName).toBe('A');
    expect(seeAll?.getAttribute('href')).toBe('/chat?folder=telegram');
  });

  it('déplie DIX fils au plus, et dit « See all » seulement s’il y en a plus', async () => {
    // Le plafond est passé de cinq à dix le 19/09/2026 au soir : la colonne
    // fait 280 px, et la moitié des dépliages se terminaient par un « See all ».
    //
    // Mutation vérifiée : `hasMore` forcé à `true` dans `unfoldedRows` → le
    // premier cas rougit, « See all » s'affiche sous neuf fils qui sont tous là.
    await renderTalk(['telegram'], 9);
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);
    expect(container.querySelectorAll('[data-testid="folder-thread-telegram"]').length).toBe(9);
    // Neuf fils, tous sous les yeux : un lien vers « tout » ferait promettre au
    // menu ce qu'il montre déjà.
    expect(container.querySelector('[data-testid="folder-see-all-telegram"]')).toBeNull();

    await remonter();
    await renderTalk(['telegram'], 11);
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);
    // Onze lues, DIX dessinées : la onzième n'est pas une ligne, c'est la
    // réponse à « y en a-t-il d'autres ? ».
    expect(container.querySelectorAll('[data-testid="folder-thread-telegram"]').length).toBe(10);
    expect(container.querySelector('[data-testid="folder-see-all-telegram"]')).not.toBeNull();
  });
});

describe('le dossier Workspaces se déplie @cap:reprendre-conversation/ecran', () => {
  /** `n` projets, tels que la lecture bornée les rend. */
  function projets(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Project ${i + 1}` }));
  }

  it('plie et déplie au clic sur son nom, comme un canal', async () => {
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: projets(3) });
    pathname = '/chat';
    await renderSidebar();

    const dossier = container.querySelector('[data-testid="inbox-folder-workspaces"]')!;
    // Le MÊME geste qu'un dossier de canal : un bouton qui plie, pas un lien.
    expect(dossier.tagName).toBe('BUTTON');
    expect(dossier.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="folder-threads-workspaces"]')).toBeNull();

    await click(dossier);
    expect(dossier.getAttribute('aria-expanded')).toBe('true');
    const lignes = [...container.querySelectorAll('[data-testid="folder-thread-workspaces"]')];
    expect(lignes.map((l) => l.getAttribute('href'))).toEqual([
      '/spaces/p1',
      '/spaces/p2',
      '/spaces/p3',
    ]);

    await click(dossier);
    // Replié, le sous-menu n'est pas seulement caché : il n'est pas rendu, donc
    // ses lignes ne restent pas dans l'ordre de tabulation.
    expect(container.querySelector('[data-testid="folder-threads-workspaces"]')).toBeNull();
  });

  it('montre DIX projets au plus, et garde « See all » TOUJOURS', async () => {
    // La SEULE différence avec un dossier de canal (décision de
    // l'orchestrateur, 19/09/2026 au soir) : ailleurs « See all » n'apparaît
    // qu'au-delà du plafond, parce qu'en dessous tout est déjà sous les yeux.
    // Ici c'est faux — `/spaces` porte aussi « New project » et sa table — et
    // comme un dossier ne navigue pas (#206), sans cette ligne la page ne
    // serait plus atteignable depuis la barre.
    //
    // Mutation vérifiée : la ligne remise sous `hasMore` → ce cas rougit à
    // trois projets, et la page devient inatteignable.
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: projets(3) });
    pathname = '/chat';
    await renderSidebar();
    await click(container.querySelector('[data-testid="inbox-folder-workspaces"]')!);
    expect(container.querySelectorAll('[data-testid="folder-thread-workspaces"]').length).toBe(3);
    expect(
      container.querySelector('[data-testid="folder-see-all-workspaces"]')?.getAttribute('href'),
    ).toBe('/spaces');

    await remonter();
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: projets(11) });
    await renderSidebar();
    await click(container.querySelector('[data-testid="inbox-folder-workspaces"]')!);
    // Onze lues, DIX dessinées : la onzième n'est pas une ligne.
    expect(container.querySelectorAll('[data-testid="folder-thread-workspaces"]').length).toBe(10);
    expect(
      container.querySelector('[data-testid="folder-see-all-workspaces"]')?.getAttribute('href'),
    ).toBe('/spaces');
  });

  it('DIT ce qu’une lecture en échec a répondu, au lieu de se taire', async () => {
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({
      ok: false,
      code: 'list_failed',
      message: 'Could not list the workspaces',
    });
    pathname = '/chat';
    await renderSidebar();
    await click(container.querySelector('[data-testid="inbox-folder-workspaces"]')!);
    // Le message, PUIS « See all » : la page reste atteignable même quand la
    // lecture échoue — c'est justement là qu'on veut pouvoir y aller.
    expect(container.querySelector('[data-testid="folder-threads-workspaces"]')?.textContent).toBe(
      'Could not list the workspacesSee all',
    );
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
    vi.mocked(listRecentThreadReadsAction).mockResolvedValue({
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

// ─── La section « Recent » se relit, comme le sous-menu (#223) ───────────────
//
// CE QUE CE BLOC PROUVE. Le sous-menu d'un dossier se relit depuis #223 —
// navigation et horloge — précisément pour que son point de non-lu ne mente
// pas. « Recent » montre les MÊMES fils, juste en dessous : figée, elle aurait
// fait dire deux heures différentes à la même barre.
//
// Mutations vérifiées : `pathname` retiré des dépendances de `relireSurRoute`
// → le premier test rougit (le point reste allumé après l'ouverture du fil) ;
// `usePolling` remplacé par un `useEffect` de montage → le second rougit (le
// point ne s'allume jamais).

describe('la section « Recent » se relit @cap:reprendre-conversation/ecran', () => {
  /**
   * Le titre du premier fil récent.
   *
   * C'est LUI qu'on observe, et non un point : depuis les planches du
   * 19/09/2026 une ligne de « Recent » ne porte aucun signal. Un titre qui
   * change à l'écran sans rechargement prouve la relecture aussi bien, et il
   * se lit dans le rendu plutôt que dans un attribut.
   */
  function titreDuPremier(): string {
    const ligne = container.querySelector('[data-testid="recent-thread"]');
    if (!ligne) throw new Error('no recent thread row');
    return ligne.textContent?.trim() ?? '';
  }

  /** Ce que la prochaine lecture rendra. */
  function semer(titre: string): void {
    vi.mocked(listRecentThreadReadsAction).mockResolvedValue({
      ok: true,
      data: [recent('r1', titre)],
    });
  }

  it('relit quand on NAVIGUE, sans rechargement', async () => {
    semer('Invoice for March');
    pathname = '/chat';
    await renderSidebar();
    expect(titreDuPremier()).toBe('Invoice for March');

    // La personne ouvre le fil, et l'IA l'a renommé entre-temps : la lecture
    // suivante rend le nouveau titre.
    semer('Invoice for April');
    pathname = '/chat/r1';
    await act(async () => {
      root.render(
        <ApprovalsProvider initial={[]}>
          <ChatFoldersProvider
            initial={{ channels: [], running: {}, runningConversationIds: [], externalRuns: 0 }}
          >
            <Sidebar workspaces={[]} />
          </ChatFoldersProvider>
        </ApprovalsProvider>,
      );
    });

    // Et la ligne change toute seule : personne n'a rechargé la page.
    expect(titreDuPremier()).toBe('Invoice for April');
  });

  it('relit sur la CADENCE de la barre, sans que rien ne navigue', async () => {
    vi.useFakeTimers();
    try {
      semer('Invoice for March');
      pathname = '/chat';
      await renderSidebar();
      expect(titreDuPremier()).toBe('Invoice for March');

      // Le fil est renommé pendant qu'on regarde autre chose. Rien ne navigue.
      semer('Invoice for April');
      expect(titreDuPremier()).toBe('Invoice for March');

      // Un tour d'horloge de la barre latérale — le MÊME que la pastille
      // corail, le point vert et le sous-menu d'un dossier — et la ligne suit.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIDEBAR_POLL_MS);
      });
      expect(titreDuPremier()).toBe('Invoice for April');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('la relecture de « Recent » laisse tomber le périmé @cap:reprendre-conversation/ecran', () => {
  it('ignore une réponse arrivée APRÈS une plus récente', async () => {
    // DEUX lectures en vol, et elles reviennent dans le désordre : c'est le
    // cas réel dès qu'une navigation en lance une pendant qu'un tour
    // d'horloge en a déjà une. Sans l'âge, la plus vieille réécrit la section
    // — et rallume le point du fil qu'on venait justement d'ouvrir.
    //
    // Le même âge couvre le second cas, une réponse qui revient après le
    // démontage, qui ne peut pas se prouver seul : sous React 19 une mise à
    // jour d'état sur un composant démonté ne dit rien.
    //
    // Mutation vérifiée : `if (mien !== age.current) return;` retiré de
    // `relire` → ce test rougit, la section affiche « Ancienne ».
    type Reponse = { ok: true; data: FolderConversationRead[] };
    const promesses: Array<(r: Reponse) => void> = [];
    vi.mocked(listRecentThreadReadsAction).mockImplementation(
      () =>
        new Promise((r) => {
          promesses.push(r as (typeof promesses)[number]);
        }) as ReturnType<typeof listRecentThreadReadsAction>,
    );

    pathname = '/chat';
    await renderSidebar();
    // Une seconde lecture part : la personne ouvre un fil.
    pathname = '/chat/r1';
    await act(async () => {
      root.render(
        <ApprovalsProvider initial={[]}>
          <ChatFoldersProvider
            initial={{ channels: [], running: {}, runningConversationIds: [], externalRuns: 0 }}
          >
            <Sidebar workspaces={[]} />
          </ChatFoldersProvider>
        </ApprovalsProvider>,
      );
    });
    expect(promesses, 'deux lectures devraient être en vol').toHaveLength(2);

    // La SECONDE répond d'abord, la PREMIÈRE ensuite.
    await act(async () => {
      promesses[1]?.({ ok: true, data: [recent('r1', 'Récente')] });
    });
    await act(async () => {
      promesses[0]?.({ ok: true, data: [recent('r1', 'Ancienne')] });
    });

    expect(container.querySelector('[data-testid="recent-thread"]')?.textContent).toBe('Récente');
  });
});

describe('le point de non-lu survit au rail @cap:reprendre-conversation/ecran', () => {
  it('rend le point sur le fil d’un DOSSIER (#209)', async () => {
    await renderTalk();
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);
    const fil = container.querySelector('[data-testid="folder-thread-telegram"]');
    expect(fil?.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls')).toBe(
      'yes',
    );
  });

  it('n’en met AUCUN dans « Recent », qui n’en dessine pas', async () => {
    await renderTalk();
    const recents = [...container.querySelectorAll('[data-testid="recent-thread"]')];
    expect(recents.length).toBeGreaterThan(0);
    // La planche du propriétaire (487:5489) ne dessine aucun signal devant un
    // fil récent : une place vide, puis le titre. L'état non lu de #209 reste
    // entier dans le sous-menu d'un dossier, qui est l'endroit où l'on choisit
    // un fil ; « Recent » est un rappel de ce qu'on vient de faire.
    for (const ligne of recents) {
      expect(ligne.querySelector('[data-testid="thread-dot"]')).toBeNull();
    }
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
    await renderTalk(['telegram'], 11);
    await click(container.querySelector('[data-testid="inbox-folder-telegram"]')!);

    // Le panneau déplié porte bien les quatre sortes de ligne : sans elles, la
    // comparaison ci-dessous ne prouverait rien.
    expect(container.querySelector('[data-testid="inbox-folder-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-thread-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folder-see-all-telegram"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recent-thread"]')).not.toBeNull();

    // Le dossier des espaces, deux dossiers de canaux, dix fils dépliés, leur
    // « See all », deux fils récents et le « See all » de la section : dix-sept
    // lignes, toutes sortes confondues.
    const lignes = [...container.querySelectorAll<HTMLElement>('[data-sidebar-row]')];
    expect(lignes.length).toBe(17);

    // UNE comparaison, pas quatre assertions : chaque ligne est la forme
    // commune, sa HAUTEUR, puis son état, et rien d'autre. Rayon, fond de
    // survol, fond actif — tout vient du même endroit.
    //
    // Deux hauteurs, et deux seulement : 30 px pour une destination, un
    // dossier ou le fil d'un dossier ; 28 px pour un fil de « Recent », que
    // les planches du 19/09/2026 dessinent d'un cran plus court.
    const attendues = new Set(
      [SIDEBAR_ROW_H.nav, SIDEBAR_ROW_H.recent].flatMap((h) => [
        `${SIDEBAR_ROW_BASE} ${h} ${SIDEBAR_ROW_IDLE}`,
        `${SIDEBAR_ROW_BASE} ${h} ${SIDEBAR_ROW_ACTIVE}`,
      ]),
    );
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

  it('se referme à Échap, et PREND la touche en le faisant', async () => {
    await renderSidebar();
    await click(railCell('help'));
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();

    const echap = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      // `cancelable`, sinon `preventDefault()` ne marque rien et l'assertion
      // ci-dessous passerait pour une raison qui n'est pas la bonne.
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(echap);
    });
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
    // La PILE DES CALQUES (#233) : celui qui reçoit la touche la PREND, sinon
    // le calque qui le porte se fermerait avec lui.
    expect(echap.defaultPrevented).toBe(true);
  });

  it('ne bouge pas quand un autre calque a déjà pris la touche', async () => {
    await renderSidebar();
    await click(railCell('help'));

    const echap = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    echap.preventDefault();
    await act(async () => {
      window.dispatchEvent(echap);
    });
    // La pile n'agit QUE si personne n'a déjà pris la touche : sans cette
    // règle, un seul Échap traverse tous les calques ouverts d'un coup.
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();
  });

  it('se ferme AVANT le menu qui la porte, parce qu’elle est plus intérieure', async () => {
    // LA règle de la pile (#233), et ce que la phase de capture ne savait pas
    // dire : le dernier calque ouvert prend la touche, pas le plus « modal ».
    // Le menu mobile couvre l'écran, la carte non — et c'est pourtant la carte
    // qui doit se fermer en premier, puisque c'est elle qu'on vient d'ouvrir.
    //
    // Mutation vérifiée : `useLayer(true, onClose)` retiré de `RailPopover`
    // → ce cas rougit, le menu se ferme et emporte la carte avec lui.
    await renderSidebar();
    await click(container.querySelector('[aria-label="Open menu"]')!);
    const menu = container.querySelector('#primary-nav')!;
    expect(menu.className).toContain('translate-x-0');

    await click(railCell('help'));
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();

    // Premier Échap : la carte, et elle seule.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
    expect(menu.className).toContain('translate-x-0');

    // Second Échap : le menu, qui est redevenu le calque du dessus.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('#primary-nav')?.className).toContain('-translate-x-full');
  });

  it('se referme au clic DEHORS, et pas au clic dedans', async () => {
    await renderSidebar();
    await click(railCell('help'));
    // Un clic DANS la carte ne la ferme pas : on vient y cliquer un lien.
    await act(async () => {
      container
        .querySelector('[data-testid="rail-popover"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
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
