// Sidebar.test.tsx — la barre latérale À L'ÉCRAN, rail et panneau (#258).
//
// Le propriétaire a redessiné la barre le 19/09/2026 au soir (Figma
// `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`, cinq planches côte à côte). Ce
// fichier prouve les sept choses que cette refonte pouvait casser sans qu'on
// le voie :
//
//   1. le rail porte CINQ destinations, plus Logs et Help, et Settings juste sous Approvals ;
//   2. la destination active se DÉDUIT de la route, et rien d'autre ;
//   3. chaque panneau porte les sections de SA planche, dans l'ordre ;
//   4. les listes du panneau se LISENT en base, bornées, et disent leurs trois
//      absences différemment — « ça charge », l'échec, et le vide ;
//   5. les points rouges et gris ne sont dessinés QUE là où la planche en met ;
//   6. le « + » n'existe que sur CRON et WEBHOOKS ;
//   7. un titre long se COUPE, il n'élargit pas la colonne.
//
// Les blocs qui ne sont pas le sujet (version, sélecteur d'espace, cloche,
// thème) sont remplacés par du vide : ils appellent chacun leur action serveur,
// et les monter ici n'aurait rien prouvé de plus sur le menu.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let pathname = '/agents';
/** Les paramètres de la route — `?page=` des réglages. Sans le « ? ». */
let search = '';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  // Les menus de ligne (RowActions) rafraîchissent la page après un geste.
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions', () => ({
  listApprovalsAction: vi.fn(),
  deleteAgentAction: vi.fn(),
  deleteConversationAction: vi.fn(),
  deleteScheduleAction: vi.fn(),
  deleteWebhookTriggerAction: vi.fn(),
  renameCodeProjectAction: vi.fn(),
  setCodeProjectHiddenAction: vi.fn(),
}));
vi.mock('@/lib/row-actions.ts', () => ({
  renameAgentAction: vi.fn(),
  renameConversationAction: vi.fn(),
  renameScheduleAction: vi.fn(),
  renameWebhookTriggerAction: vi.fn(),
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
vi.mock('../VersionBadge', () => ({ default: () => null }));
vi.mock('../WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider, type PendingApproval } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { listApprovalsAction } from '@/lib/actions';
import { getChatFoldersAction } from '@/lib/conversation-actions.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import {
  listSidebarAgentsAction,
  listSidebarCronAction,
  listSidebarWebhooksAction,
  listSidebarRecentApprovalsAction,
} from '@/lib/sidebar-actions.ts';
import {
  SIDEBAR_ROW_BASE,
  SIDEBAR_ROW_H,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_IDLE,
  SIDEBAR_ROW_IDLE_CONTENT,
} from '../ui/SidebarRow';
import { RAIL_CELL, RAIL_CELL_ACTIVE, RAIL_CELL_IDLE } from '../ui/RailCell';
import { SIDEBAR_POLL_MS } from '@/lib/use-polling';
import { DESTINATIONS, RAIL_FOOT } from '../sidebar-nav.ts';
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

const ESPACES = [
  { id: 'w1', name: 'Local', slug: 'local', icon: null, active: true },
] as unknown as Parameters<typeof Sidebar>[0]['workspaces'];

async function renderSidebar(
  channels: string[] = [],
  attentes: PendingApproval[] = [],
  /**
   * CE QUI TOURNE, tel que le provider le porte (#300, #303). Ce que le test
   * ne dit pas vaut zero : une barre ou rien ne tourne est l'etat courant.
   */
  tourne: { runsInProgress?: number; workConversationsInProgress?: number } = {},
): Promise<void> {
  await render(
    <ApprovalsProvider initial={attentes}>
      <ChatFoldersProvider
        initial={{
          channels,
          running: {},
          runningConversationIds: [],
          externalRuns: 0,
          runsInProgress: tourne.runsInProgress ?? 0,
          workConversationsInProgress: tourne.workConversationsInProgress ?? 0,
        }}
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

/** Les libellés des ENTRÉES ÉCRITES d'un groupe, dans l'ordre rendu. */
function groupLabels(section: string): string[] {
  const group = container.querySelector(`[data-testid="nav-group-${section}"]`);
  if (!group) throw new Error(`no group "${section}"`);
  return (
    [...group.querySelectorAll('a')]
      // Le « + » du titre est un lien lui aussi : il n'est pas une entrée.
      .filter((a) => a.getAttribute('data-testid') !== 'section-add')
      .map((a) => a.textContent?.trim() ?? '')
  );
}

/** Les titres de section du panneau, dans l'ordre rendu. */
function sectionTitles(): string[] {
  const panneau = container.querySelector('[data-testid="sidebar-panel"]');
  return [...(panneau?.querySelectorAll('[data-testid^="nav-group-"]') ?? [])]
    .map((g) => g.firstElementChild)
    .filter((el): el is Element => el !== null && el.className.includes('pt-4'))
    .map((el) => el.firstElementChild?.textContent?.trim() ?? '');
}

/** Les lignes LUES d'une section, dans l'ordre rendu. */
function listRows(key: string): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>(`[data-testid="sidebar-row-${key}"]`)];
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Un fil d'un sous-menu de dossier, réduit à ce que le menu en rend. */
function thread(over: Partial<FolderThread> & { key: string; title: string }): FolderThread {
  return { href: `/chat/${over.key}`, waiting: false, running: false, unread: false, ...over };
}

/** `n` lignes nommées, telles qu'une lecture bornée les rend. */
function nommees(n: number, prefixe: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefixe}${i + 1}`,
    name: `${prefixe} ${i + 1}`,
  }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  pathname = '/agents';
  search = '';
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarAgentsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarCronAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarWebhooksAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarRecentApprovalsAction).mockResolvedValue({ ok: true, data: [] });
  // LES DEUX PROVIDERS VOISINS RÉPONDENT, MÊME SI AUCUN TEST NE LES REGARDE.
  // Ils posent chacun un `setInterval` de 15 s ; dès qu'un test fait tourner
  // l'horloge, leurs actions partent aussi. Sans valeur de retour, elles
  // rendent `undefined`, et le `result.ok` du provider lève une rejection non
  // rattrapée qui fait rougir la suite ENTIÈRE sans qu'aucun test n'échoue
  // (le piège que la CI de la PR #223 a déjà attrapé une fois).
  vi.mocked(listApprovalsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(getChatFoldersAction).mockResolvedValue({
    ok: true,
    data: {
      channels: [],
      running: {},
      runningConversationIds: [],
      externalRuns: 0,
      runsInProgress: 0,
      workConversationsInProgress: 0,
    },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

// ─── 1. Le rail : cinq destinations, Logs, Help ──────────────────────────────

describe('le rail porte cinq destinations @cap:installer-et-demarrer/ecran', () => {
  it('rend Work, Agents, Run, Approvals, Settings, puis Logs et Help', async () => {
    await renderSidebar();
    for (const key of ['work', 'agents', 'run', 'approvals', 'logs', 'settings', 'help']) {
      expect(railCell(key), `le rail porte « ${key} »`).not.toBeNull();
    }
    // « Agents » AU PLURIEL depuis la v2 : le panneau liste les agents, on n'en
    // règle plus un à la fois.
    expect(railCell('agents').textContent?.trim()).toBe('Agents');
    expect(railCell('work').textContent?.trim()).toBe('Work');
    expect(railCell('run').textContent?.trim()).toBe('Run');
    expect(railCell('logs').textContent?.trim()).toBe('Logs');
    // Les noms de la v1 ont disparu, et ils ne se cachent nulle part.
    expect(() => navLink('Talk')).toThrow();
    expect(() => navLink('Build')).toThrow();
    expect(() => navLink('Agent')).toThrow();
  });

  it('range Settings juste SOUS Approvals, dans le groupe du haut', async () => {
    // Quentin, 20/09 : « mets l'onglet Settings juste sous Approvals ». Plus
    // aucune destination sous la séparation ; il n'y reste que Logs et Help.
    // Le fait vit dans `sidebar-nav`, pas dans le rendu du rail.
    //
    // Mutation vérifiée : `foot: true` remis sur Settings → ce cas rougit, la
    // case redescend sous Logs.
    expect(DESTINATIONS.filter((d) => d.foot === true).map((d) => d.key)).toEqual([]);

    await renderSidebar();
    const cases = [...container.querySelectorAll('[data-testid^="rail-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(cases).toEqual([
      'rail-work',
      'rail-agents',
      'rail-run',
      'rail-approvals',
      'rail-settings',
      'rail-logs',
      'rail-help',
    ]);
  });

  it('fait NAVIGUER Logs, et fait OUVRIR une carte à Help', async () => {
    await renderSidebar();
    // Logs mène à sa page et n'ouvre aucun panneau : c'est la seule case du
    // rail que la table des destinations ne connaît pas.
    expect(railCell('logs').getAttribute('href')).toBe('/logs');
    expect(railCell('logs').getAttribute('target')).toBeNull();

    // Help ne MÈNE nulle part : c'est un bouton, et il ouvre une carte.
    expect(railCell('help').tagName).toBe('BUTTON');
    expect(railCell('help').getAttribute('href')).toBeNull();
    expect(railCell('help').getAttribute('aria-expanded')).toBe('false');
  });

  it('donne la MÊME forme aux cases, active ou non', async () => {
    await renderSidebar();
    const formes = new Set(
      ['work', 'agents', 'run', 'logs', 'settings', 'help'].map((k) => railCell(k).className),
    );
    const attendues = new Set([
      `relative ${RAIL_CELL} ${RAIL_CELL_IDLE}`,
      `relative ${RAIL_CELL} ${RAIL_CELL_ACTIVE}`,
    ]);
    // La route est /agents : Agents est active, les autres non. Les DEUX états
    // sont donc là — sans cela, la comparaison ne prouverait rien.
    expect(railCell('agents').className).toBe(`relative ${RAIL_CELL} ${RAIL_CELL_ACTIVE}`);
    expect(formes.has(`relative ${RAIL_CELL} ${RAIL_CELL_IDLE}`)).toBe(true);
    for (const forme of formes) {
      expect(attendues.has(forme), `forme de case inattendue : « ${forme} »`).toBe(true);
    }
  });

  it('dessine la case active PLEINE LARGEUR, sans bordure', async () => {
    // Trois mesures de la planche v2, et trois écarts avec la v1 : 64 px de
    // large dans un rail de 72 (elle en faisait 56), rayon 4 (elle avait `xl`),
    // et AUCUNE bordure (elle en portait une).
    //
    // Mutation vérifiée : `w-16` remis à `w-14` → ce cas rougit.
    expect(RAIL_CELL).toContain('w-16');
    expect(RAIL_CELL).toContain('rounded-[4px]');
    expect(RAIL_CELL_ACTIVE).toContain('bg-paper');
    expect(RAIL_CELL_ACTIVE).not.toContain('border');
  });
});

// ─── Approvals : une DESTINATION, et sa pastille ─────────────────────────────

describe('la case Approvals du rail @cap:approuver-une-action/ecran', () => {
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

  it('OUVRE UN PANNEAU depuis la v2, au lieu de seulement naviguer', async () => {
    pathname = '/approvals';
    await renderSidebar();
    expect(railCell('approvals').getAttribute('aria-current')).toBe('page');
    // Le changement de la v2 : la case allumée et le panneau montré disent
    // enfin la même chose. En v1 on tombait dans les approbations avec le
    // menu de Run sous les yeux.
    expect(
      container.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('aria-label'),
    ).toBe('Approvals');
    for (const key of ['work', 'agents', 'run']) {
      expect(railCell(key).getAttribute('aria-current'), key).toBeNull();
    }
  });

  it('porte le NOMBRE de demandes en attente, et RIEN à zéro', async () => {
    // Mutation vérifiée : `pill={approvalsCount}` remplacé par `pill={0}`
    // dans `SidebarRail` → ce cas rougit, la case n'écrit plus rien.
    await renderSidebar([], attente(3));
    expect(railCell('approvals').textContent?.trim()).toBe('Approvals3');
    await remonter();
    // Une pastille « 0 » demande d'être lue pour apprendre qu'il n'y a rien à
    // faire : à zéro, la case ne porte que son nom.
    await renderSidebar([], []);
    expect(railCell('approvals').textContent?.trim()).toBe('Approvals');
  });

  it('est la SEULE case du rail à compter quelque chose', async () => {
    await renderSidebar([], attente(3));
    const avecPastille = [...container.querySelectorAll('[data-testid^="rail-"]')].filter((el) =>
      /\d/.test(el.textContent ?? ''),
    );
    expect(avecPastille.map((el) => el.getAttribute('data-testid'))).toEqual(['rail-approvals']);
  });

  it('DIT ce que le nombre compte, au lieu de le coller au libellé', async () => {
    // Sans nom accessible, un lecteur d'écran annonce « Approvals 3 » : le
    // libellé et le chiffre collés, sans un mot pour dire ce qu'il compte.
    //
    // Mutation vérifiée : l'`aria-label` retiré de `RailCell` → ce cas rougit.
    await renderSidebar([], attente(3));
    expect(railCell('approvals').getAttribute('aria-label')).toBe('Approvals, 3 pending');
    await remonter();
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
    ['/agents', 'agents', 'Agents'],
    ['/agents/a1', 'agents', 'Agents'],
    ['/memories', 'agents', 'Agents'],
    ['/mcp', 'agents', 'Agents'],
    ['/llm-providers', 'settings', 'Settings'],
    ['/chat', 'work', 'Work'],
    ['/chat/abc', 'work', 'Work'],
    ['/spaces', 'work', 'Work'],
    // La racine rend un fil vide depuis l'issue #248 : c'est Work, pas Run.
    ['/', 'work', 'Work'],
    ['/dashboard', 'run', 'Run'],
    ['/automations', 'run', 'Run'],
    // Une page de run n'a pas d'entrée dans le panneau, mais elle allume bien
    // une destination : un rail sans case active se lirait comme cassé.
    ['/jobs/j1', 'run', 'Run'],
    // Les deux qui ont GAGNÉ un panneau en v2.
    ['/approvals', 'approvals', 'Approvals'],
    ['/settings', 'settings', 'Settings'],
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

  it('allume Logs sur /logs, et montre alors le panneau de REPLI', async () => {
    pathname = '/logs';
    await renderSidebar();
    expect(destinationActive()).toBe('logs');
    // Logs n'ouvre AUCUN panneau : le repli est Work, la racine du produit, et
    // il est le même pour tout le monde — ce qu'une « dernière destination
    // visitée » n'aurait pas été.
    expect(
      container.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('aria-label'),
    ).toBe('Work');
  });
});

// ─── 2. Les cinq panneaux, section par section ───────────────────────────────

describe('chaque panneau porte les sections de SA planche @cap:installer-et-demarrer/ecran', () => {
  it('Work : WORKSPACES puis CHANNELS, et rien d’écrit', async () => {
    pathname = '/chat';
    await renderSidebar();
    expect(sectionTitles()).toEqual(['Projects', 'Channels']);
    // Aucune entrée ÉCRITE : les deux blocs sont lus en base de bout en bout.
    expect(groupLabels('Projects').filter((l) => l !== 'See all')).toEqual([]);
  });

  it('Agents : le dossier des agents, puis CONNECT', async () => {
    pathname = '/agents';
    await renderSidebar();
    expect(sectionTitles()).toEqual(['Agents', 'Connect']);
    // Le dossier « Agents » ouvre le bloc — c'est un BOUTON qui plie, pas une
    // entrée de menu, et c'est pour cela qu'il ne figure pas dans cette liste.
    expect(container.querySelector('[data-testid="inbox-folder-agents"]')).not.toBeNull();
    expect(groupLabels('Agents')).toEqual(['Skills', 'Learned Skills', 'Memory']);
    expect(groupLabels('Connect')).toEqual(['API Connectors', 'MCP Connectors', 'Credentials']);
  });

  it('Run : CRON puis WEBHOOKS, et rien au-dessus', async () => {
    pathname = '/automations';
    await renderSidebar();
    expect(sectionTitles()).toEqual(['Cron', 'Webhooks']);
    // « Dashboard » N'EST PLUS DANS LE PANNEAU (Quentin, 20/09 : « je l'ai
    // enlevé »). La page `/dashboard` existe encore, sans lien vers elle ;
    // le panneau ne porte que ce que la planche dessine.
    expect(container.querySelector('[data-testid="nav-group-0"]')).toBeNull();
    expect(
      [...container.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Dashboard'),
    ).toBe(false);
  });

  it('la case Run du rail MÈNE au tableau de bord, pas à la racine', async () => {
    pathname = '/logs';
    await renderSidebar();
    // Une case du rail est un LIEN, et elle mène là où mène la PREMIÈRE LIGNE
    // de son panneau. Tant que `/` était le tableau de bord, Run y menait
    // juste ; depuis #248 la racine rend un fil vide, et cliquer Run emmenait
    // donc sur Work, qui s'allumait à sa place. Les deux cases sont vérifiées
    // ensemble : les confondre est justement la faute qu'on a corrigée.
    // Depuis le 20/09 la première ligne de Run est CRON, dont le « + » mène aux
    // automatisations : la case y mène aussi.
    expect(railCell('run').getAttribute('href')).toBe('/automations');
    expect(railCell('work').getAttribute('href')).toBe('/');
  });

  it('ne propose « Code » dans aucun des cinq panneaux', async () => {
    for (const route of ['/', '/agents', '/chat', '/automations', '/approvals', '/settings']) {
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

  it('Approvals : APPROVALS puis RECENTS', async () => {
    pathname = '/approvals';
    await renderSidebar();
    expect(sectionTitles()).toEqual(['Approvals', 'Recents']);
  });

  it('Settings : les quatre familles, chacune ouvrant un réglage RÉEL', async () => {
    pathname = '/settings';
    await renderSidebar();
    expect(sectionTitles()).toEqual(['Settings']);
    expect(groupLabels('Settings')).toEqual([
      'Access',
      'Safety',
      'Workspace',
      'LLM Providers',
      'Install',
    ]);
    // Depuis le 20/09 chaque entrée est une PAGE de réglages (`?page=`), ses
    // formulaires en place et sans panneau ; « Install » est la page de la
    // seule ligne « Install notes », et LLM Providers a la sienne.
    expect(navLink('Access').getAttribute('href')).toBe('/settings?page=access');
    expect(navLink('Safety').getAttribute('href')).toBe('/settings?page=safety');
    expect(navLink('Workspace').getAttribute('href')).toBe('/settings?page=workspace');
    expect(navLink('Install').getAttribute('href')).toBe('/settings?page=install');
  });

  it('n’allume QUE le réglage ouvert, et aucun sur /settings nu', async () => {
    // Les quatre mènent à `/settings` avec un `?page=` différent. Comparer sur
    // le CHEMIN seul les allumait toutes les quatre — quatre lignes qui se
    // disent « la page où vous êtes » (passe 1 de la revue de la PR #279) ;
    // comparer sur la chaîne entière n'en allumait aucune, même la bonne,
    // parce que `usePathname` s'arrête au chemin. La règle lit donc les DEUX :
    // le chemin, puis chaque paramètre que l'entrée écrit.
    //
    // Mutation vérifiée : le `href.split('?')[0]` de la v1 remis dans
    // `isPanelItemActive` → ce cas rougit, les quatre s'allument d'un coup.
    pathname = '/settings';
    search = 'page=workspace';
    await renderSidebar();
    const allumees = () => {
      const panneau = container.querySelector('[data-testid="sidebar-panel"]');
      return [...(panneau?.querySelectorAll('[data-sidebar-row]') ?? [])]
        .filter((r) => r.className.includes(SIDEBAR_ROW_ACTIVE))
        .map((r) => r.textContent?.trim() ?? '');
    };
    expect(allumees()).toEqual(['Workspace']);

    await remonter();
    search = 'page=install';
    await renderSidebar();
    expect(allumees()).toEqual(['Install']);

    await remonter();
    // UN RÉGLAGE QUE LE PANNEAU N'ÉCRIT PAS. `page=advanced` est une valeur
    // réel de la page, qu'aucune des quatre lignes n'ouvre : la CLÉ est la
    // bonne, la VALEUR n'est celle d'aucune. Comparer la seule présence de
    // `open` les allumerait toutes les quatre ici.
    //
    // Mutation vérifiée : `courants.get(cle) !== valeur` remplacé par
    // `!courants.has(cle)` → ce cas rougit, les quatre s'allument.
    search = 'page=advanced';
    await renderSidebar();
    expect(allumees()).toEqual([]);

    await remonter();
    // `/settings` NU : la route ne dit aucun réglage ouvert, donc aucune ligne
    // ne se prétend courante — ce que la planche dessine. La case du rail,
    // elle, s'allume : c'est là que se lit où l'on est.
    search = '';
    await renderSidebar();
    expect(allumees()).toEqual([]);
    expect(railCell('settings').getAttribute('aria-current')).toBe('page');
  });

  it('ne fait PAS dépendre une entrée sans paramètre de ceux de la route', async () => {
    // `/skills?tab=installed` est la page de `/skills`, et sa ligne doit
    // rester allumée : la règle des paramètres ne vaut que pour les entrées
    // qui en écrivent un.
    pathname = '/skills';
    search = 'tab=installed';
    await renderSidebar();
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    const actives = [...(panneau?.querySelectorAll('[data-sidebar-row]') ?? [])].filter((r) =>
      r.className.includes(SIDEBAR_ROW_ACTIVE),
    );
    expect(actives.map((r) => r.textContent?.trim())).toEqual(['Skills']);
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

// ─── 3. Le « + », seulement où la planche en dessine un ──────────────────────

describe('le « + » d’un titre de section @cap:planifier-une-tache/ecran', () => {
  it('n’existe QUE sur CRON et WEBHOOKS', async () => {
    // Mutation vérifiée : un `add` posé sur la section WORKSPACES → ce cas
    // rougit, le menu promet une création qui n'existe pas là.
    pathname = '/automations';
    await renderSidebar();
    const plus = [...container.querySelectorAll('[data-testid="section-add"]')];
    expect(plus.map((a) => a.getAttribute('aria-label'))).toEqual([
      'New automation',
      'New webhook',
    ]);
    // Chaque « + » OUVRE son formulaire en arrivant (20/09) : un lien vers la
    // page nue ne faisait rien quand on y était déjà.
    expect(plus.map((a) => a.getAttribute('href'))).toEqual([
      '/automations?new=schedule',
      '/automations?new=webhook',
    ]);

    for (const route of ['/chat', '/agents', '/approvals', '/settings']) {
      await remonter();
      pathname = route;
      await renderSidebar();
      expect(container.querySelector('[data-testid="section-add"]'), route).toBeNull();
    }
  });

  it('DIT le geste, et pas le signe', async () => {
    // Un lecteur d'écran doit annoncer « New automation », pas « plus ».
    pathname = '/automations';
    await renderSidebar();
    const plus = container.querySelector('[data-testid="section-add"]');
    expect(plus?.getAttribute('title')).toBe('New automation');
  });
});

// ─── 4. Les listes lues : bornes, vide, échec ────────────────────────────────

describe('les listes du panneau se lisent en base @cap:installer-et-demarrer/ecran', () => {
  it('borne chaque lecture à UN DE PLUS que ce qu’elle dessine', async () => {
    // La ligne en trop n'est jamais affichée : elle est la RÉPONSE à « y en
    // a-t-il d'autres ? ». Le demander à la base, plutôt que de lire toute la
    // table et de couper après, est ce que la passe 1 de la revue de la PR
    // #206 a exigé.
    //
    // Mutation vérifiée : `FOLDER_THREADS_PROBE` remplacé par 1000 → ce cas
    // rougit, la barre redemande une liste entière à chaque tour d'horloge.
    pathname = '/automations';
    vi.mocked(listSidebarCronAction).mockResolvedValue({ ok: true, data: nommees(11, 'Cron') });
    await renderSidebar();
    expect(vi.mocked(listSidebarCronAction).mock.calls[0]?.[0]).toBe(11);
    // Onze lues, DIX dessinées, et un « See all » qui dit le reste.
    expect(listRows('cron').length).toBe(10);
    expect(container.querySelector('[data-testid="see-all-cron"]')?.getAttribute('href')).toBe(
      '/automations',
    );
  });

  it('ne dit « See all » que s’il y en a d’AUTRES', async () => {
    pathname = '/automations';
    vi.mocked(listSidebarCronAction).mockResolvedValue({ ok: true, data: nommees(3, 'Cron') });
    await renderSidebar();
    expect(listRows('cron').length).toBe(3);
    // Trois lignes, toutes sous les yeux : un lien vers « tout » ferait
    // promettre au menu ce qu'il montre déjà.
    expect(container.querySelector('[data-testid="see-all-cron"]')).toBeNull();
  });

  it('encadre le vide, avec la phrase de la planche', async () => {
    pathname = '/automations';
    await renderSidebar();
    const vides = [...container.querySelectorAll('[data-testid="sidebar-empty"]')];
    expect(vides.map((v) => v.textContent?.trim())).toEqual([
      'No Existing Automation',
      'No Existing Webhook',
    ]);
    // Le cadre est en POINTILLÉS : il montre la place d'une chose qui n'est
    // pas encore là. Un cadre plein aurait dessiné un objet.
    expect(vides[0]?.className).toContain('border-dashed');
    // Et ses couleurs sont des JETONS, jamais l'hexadécimal de la planche : le
    // produit a deux thèmes, et `#242424` n'en dit qu'un.
    expect(vides[0]?.className).toContain('border-rule-2');
    expect(vides[0]?.className).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('DIT ce qu’une lecture en échec a répondu, au lieu de se taire', async () => {
    // Une liste vide se lirait « il n'y a rien ici », ce qui est un fait que
    // la lecture n'a justement pas établi (invariant #4).
    //
    // Mutation vérifiée : la branche `erreur` remplacée par un `return null`
    // → ce cas rougit, la section se tait.
    pathname = '/automations';
    vi.mocked(listSidebarWebhooksAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to load webhooks',
    });
    await renderSidebar();
    const panneau = container.querySelector('[data-testid="sidebar-panel"]');
    expect(panneau?.textContent).toContain('Failed to load webhooks');
    // Et AUCUN cadre de vide : « rien ici » et « je n'ai pas pu lire » ne se
    // ressemblent pas.
    expect(listRows('webhooks').length).toBe(0);
    const vides = [...container.querySelectorAll('[data-testid="sidebar-empty"]')];
    expect(vides.map((v) => v.textContent?.trim())).toEqual(['No Existing Automation']);
  });

  it('relit sur la CADENCE de la barre, sans que rien ne navigue', async () => {
    // La MÊME cadence que la pastille corail, le point vert et le sous-menu
    // d'un dossier : une liste qui se rafraîchirait plus vite qu'une autre
    // ferait dire deux heures différentes à la même barre.
    //
    // Mutation vérifiée : `usePolling` remplacé par un `useEffect` de montage
    // dans `useSidebarRead` → ce cas rougit, la ligne ne change jamais.
    vi.useFakeTimers();
    try {
      pathname = '/automations';
      vi.mocked(listSidebarCronAction).mockResolvedValue({
        ok: true,
        data: [{ id: 'c1', name: 'Morning digest' }],
      });
      await renderSidebar();
      expect(listRows('cron')[0]?.textContent?.trim()).toBe('Morning digest');

      vi.mocked(listSidebarCronAction).mockResolvedValue({
        ok: true,
        data: [{ id: 'c1', name: 'Evening digest' }],
      });
      expect(listRows('cron')[0]?.textContent?.trim()).toBe('Morning digest');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIDEBAR_POLL_MS);
      });
      expect(listRows('cron')[0]?.textContent?.trim()).toBe('Evening digest');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignore une réponse arrivée APRÈS une plus récente', async () => {
    // DEUX lectures en vol, revenues dans le désordre : le cas réel dès qu'une
    // navigation en lance une pendant qu'un tour d'horloge en a déjà une. Sans
    // l'âge, la plus vieille réécrit la section avec un état périmé.
    //
    // Mutation vérifiée : `if (mien !== age.current) return;` retiré de
    // `useSidebarRead` → ce test rougit, la section affiche « Ancienne ».
    type Reponse = { ok: true; data: Array<{ id: string; name: string }> };
    const promesses: Array<(r: Reponse) => void> = [];
    vi.mocked(listSidebarCronAction).mockImplementation(
      () =>
        new Promise((r) => {
          promesses.push(r as (typeof promesses)[number]);
        }) as ReturnType<typeof listSidebarCronAction>,
    );

    pathname = '/automations';
    await renderSidebar();
    // Une seconde lecture part : la personne navigue.
    pathname = '/automations/c1';
    await act(async () => {
      root.render(
        <ApprovalsProvider initial={[]}>
          <ChatFoldersProvider
            initial={{
              channels: [],
              running: {},
              runningConversationIds: [],
              externalRuns: 0,
              runsInProgress: 0,
              workConversationsInProgress: 0,
            }}
          >
            <Sidebar workspaces={[]} />
          </ChatFoldersProvider>
        </ApprovalsProvider>,
      );
    });
    expect(promesses.length, 'deux lectures devraient être en vol').toBeGreaterThanOrEqual(2);

    // La DERNIÈRE répond d'abord, la PREMIÈRE ensuite.
    await act(async () => {
      promesses[promesses.length - 1]?.({ ok: true, data: [{ id: 'c1', name: 'Récente' }] });
    });
    await act(async () => {
      promesses[0]?.({ ok: true, data: [{ id: 'c1', name: 'Ancienne' }] });
    });

    expect(listRows('cron')[0]?.textContent?.trim()).toBe('Récente');
  });
});

// ─── 5. Les points : seulement là où la planche en met ───────────────────────

describe('le point d’une ligne du panneau @cap:reprendre-conversation/ecran', () => {
  it('est ROUGE sur un espace de travail qui a du non-lu, GRIS sinon', async () => {
    // ⚠️ CE N'EST PAS UN ÉTAT DU PROJET. Un projet n'a pas de marqueur de
    // lecture ; le point est LU par la chaîne qui existe — un projet a des
    // travaux, un travail a une conversation, une conversation a un marqueur.
    //
    // Mutation vérifiée : `calls: p.unread` remplacé par `calls: false` dans
    // `WorkspacesList` → ce cas rougit, tous les points deviennent gris.
    pathname = '/chat';
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({
      ok: true,
      data: [
        { id: 'p1', name: 'Suivis Candidatures', path: 'D:/p1', unread: true },
        { id: 'p2', name: 'Recipes', path: 'D:/p2', unread: false },
      ],
    });
    await renderSidebar();
    const lignes = listRows('workspaces');
    expect(lignes.map((l) => l.getAttribute('href'))).toEqual(['/spaces/p1', '/spaces/p2']);
    expect(
      lignes.map((l) => l.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls')),
    ).toEqual(['yes', 'no']);
  });

  it('en met un d’ACTIVITÉ sur les agents, et aucun sur les automatisations', async () => {
    // Le point d'un agent dit « il travaille » (planche 25:1062, 20/09) : lime
    // et battant quand un de ses jobs est en vol, gris au repos. Une tâche
    // planifiée, elle, n'attend rien de personne et reste nue.
    pathname = '/agents';
    vi.mocked(listSidebarAgentsAction).mockResolvedValue({
      ok: true,
      data: [
        { id: 'a1', name: 'Alfred (Root)', running: true },
        { id: 'a2', name: 'Researcher', running: false },
      ],
    });
    await renderSidebar();
    const agents = listRows('agents');
    expect(agents.length).toBe(2);
    expect(agents[0]!.querySelector('[data-testid="running-dot"]')).not.toBeNull();
    expect(agents[0]!.querySelector('[data-testid="thread-dot"]')).toBeNull();
    expect(agents[1]!.querySelector('[data-testid="running-dot"]')).toBeNull();
    expect(agents[1]!.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls')).toBe(
      'no',
    );

    await remonter();
    pathname = '/automations';
    vi.mocked(listSidebarCronAction).mockResolvedValue({ ok: true, data: nommees(2, 'Cron') });
    await renderSidebar();
    expect(listRows('cron').length).toBe(2);
    for (const l of listRows('cron')) {
      expect(l.querySelector('[data-testid="thread-dot"]')).toBeNull();
    }
  });

  it('est ROUGE sur une demande en attente, GRIS sur une décision rendue', async () => {
    pathname = '/approvals';
    vi.mocked(listSidebarRecentApprovalsAction).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'r1',
          name: 'Researcher',
          toolName: 'web_search',
          what: 'Search the web for « nodal »',
          status: 'approved',
          resolvedAt: '2026-09-20T10:00:00.000Z',
          answer: null,
        },
      ],
    });
    await renderSidebar(
      [],
      [
        {
          id: 'a1',
          jobId: 'j1',
          toolName: 'run_command',
          agentName: 'Lead-Dev',
          toolInput: {},
          requestedAt: null,
          jobChannel: 'dashboard',
          conversationChannel: 'dashboard',
        },
      ],
    );
    const attente = listRows('approvals');
    expect(attente.map((l) => l.textContent?.trim())).toEqual(['Lead-Dev']);
    expect(
      attente[0]?.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls'),
    ).toBe('yes');

    const rendues = listRows('recents');
    // La ligne dit CE QUE la demande voulait faire, pas qui la posait (20/09) ;
    // l'agent et l'outil sont en infobulle, et la ligne mène au fil concerné.
    expect(rendues.map((l) => l.textContent?.trim())).toEqual(['Search the web for « nodal »']);
    expect(rendues[0]?.getAttribute('title')).toBe('Researcher · web_search');
    // Gris : plus rien n'attend là. C'est tout ce qui sépare les deux sections.
    expect(
      rendues[0]?.querySelector('[data-testid="thread-dot"]')?.getAttribute('data-calls'),
    ).toBe('no');
    // Une ligne rendue ouvre la CARTE de la demande dans la vue principale
    // (Quentin, 20/09) — pas le fil, pas un résumé dans la barre — et seule
    // celle dont la carte est ouverte s'allume.
    expect(rendues[0]?.getAttribute('href')).toBe('/approvals?show=r1');
    expect(rendues[0]?.className).not.toContain(SIDEBAR_ROW_ACTIVE.split(' ')[0]!);

    await remonter();
    search = 'show=r1';
    await renderSidebar();
    const ouverte = listRows('recents')[0]!;
    expect(ouverte.closest('[data-sidebar-row]')?.className).toContain(SIDEBAR_ROW_ACTIVE);
  });

  it('ne lit PAS les approbations en attente une seconde fois', async () => {
    // `ApprovalsProvider` tient déjà le compte pour la pastille du rail et la
    // cloche. Une seconde lecture des mêmes lignes ferait dire deux nombres
    // différents à la même barre le temps d'un tour d'horloge.
    pathname = '/approvals';
    await renderSidebar();
    expect(container.querySelector('[data-testid="sidebar-list-approvals"]')).toBeNull();
    expect(
      [...container.querySelectorAll('[data-testid="sidebar-empty"]')].map((v) =>
        v.textContent?.trim(),
      ),
    ).toContain('No Approval Requests');
  });
});

// ─── 6. Le panneau Work : espaces, canaux ────────────────────────────────────

describe('le panneau Work @cap:reprendre-conversation/ecran', () => {
  it('liste les espaces de travail SANS dossier à déplier', async () => {
    // Ils se dépliaient comme un canal en #230 ; la planche v2 en fait les
    // lignes mêmes de la section. Une section de destinations ne se plie pas.
    pathname = '/chat';
    await renderSidebar();
    expect(container.querySelector('[data-testid="inbox-folder-workspaces"]')).toBeNull();
  });

  it('garde « See all » même sous le plafond, parce que /spaces porte plus', async () => {
    // La planche ne le dessine pas : elle montre cinq espaces, c'est-à-dire un
    // cas où il n'y a rien de plus à voir. Il est gardé parce que `/spaces`
    // porte aussi « New project » et sa table, et que sans lui la page ne
    // serait plus atteignable depuis la barre — le raisonnement que le
    // propriétaire a retenu pour « Dashboard » le 19/09 au soir.
    //
    // ⚠️ ET IL SURVIT AUX TROIS ABSENCES : aucune ligne, une lecture qui n'a
    // pas répondu, une lecture en échec. C'est justement sur une installation
    // NEUVE — zéro projet — qu'on a besoin d'aller créer le premier, et la
    // ligne disparaissait alors avec la liste. Le parcours Playwright l'a dit
    // avant un humain.
    //
    // Mutation vérifiée : `seeAllAlways` retiré → ce cas rougit à un seul
    // espace, et la page devient inatteignable.
    pathname = '/chat';
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({
      ok: true,
      data: [{ id: 'p1', name: 'Recipes', path: 'D:/p1', unread: false }],
    });
    await renderSidebar();
    expect(
      container.querySelector('[data-testid="see-all-workspaces"]')?.getAttribute('href'),
    ).toBe('/spaces');

    await remonter();
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: [] });
    await renderSidebar();
    // Le cadre du vide, PUIS la ligne : les deux, et pas l'un ou l'autre.
    expect(container.querySelector('[data-testid="sidebar-empty"]')?.textContent?.trim()).toBe(
      'No Project Yet',
    );
    expect(
      container.querySelector('[data-testid="see-all-workspaces"]')?.getAttribute('href'),
    ).toBe('/spaces');

    await remonter();
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Could not list the workspaces',
    });
    await renderSidebar();
    // Une lecture en échec est précisément le moment où l'on veut pouvoir
    // aller voir la page par soi-même.
    expect(container.querySelector('[data-testid="sidebar-list-workspaces"]')?.textContent).toBe(
      'Could not list the workspacesSee all',
    );
  });

  it('DÉPLIE « Nodal chats » au chargement, et laisse les canaux pliés', async () => {
    // La planche le dessine ouvert, ses derniers fils sous les yeux, pendant
    // que Telegram, Discord, WhatsApp et MCP restent pliés. C'est le seul
    // dossier dont on VIENT : les replier faisait commencer chaque visite par
    // un clic.
    //
    // Mutation vérifiée : l'état initial remis à `{}` → ce cas rougit, le
    // dossier arrive fermé.
    vi.mocked(listFolderThreadsAction).mockResolvedValue({
      ok: true,
      data: { dashboard: [thread({ key: 'd1', title: 'Recipes' })] },
    });
    pathname = '/chat';
    await renderSidebar(['telegram']);
    expect(
      container
        .querySelector('[data-testid="inbox-folder-dashboard"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="folder-thread-dashboard"]')?.textContent,
    ).toContain('Recipes');
    expect(
      container
        .querySelector('[data-testid="inbox-folder-telegram"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('n’affiche un canal que lorsqu’il est branché', async () => {
    pathname = '/chat';
    await renderSidebar([]);
    // « Nodal chats » est une destination permanente : elle est toujours là.
    expect(container.querySelector('[data-testid="inbox-folder-dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-folder-discord"]')).toBeNull();

    await remonter();
    await renderSidebar(['discord', 'whatsapp']);
    expect(container.querySelector('[data-testid="inbox-folder-discord"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-folder-whatsapp"]')).not.toBeNull();
  });
});

// ─── 7. Le panneau Agents : un dossier ouvert ────────────────────────────────

describe('le dossier « Agents » @cap:creer-agent/ecran', () => {
  it('arrive DÉPLIÉ et liste les agents, chacun vers sa page', async () => {
    pathname = '/agents';
    vi.mocked(listSidebarAgentsAction).mockResolvedValue({
      ok: true,
      data: [
        { id: 'a1', name: 'Alfred (Root)' },
        { id: 'a2', name: 'Researcher' },
      ],
    });
    await renderSidebar();
    const dossier = container.querySelector('[data-testid="inbox-folder-agents"]')!;
    // Un BOUTON qui plie, pas un lien : le même geste qu'un dossier de canal.
    expect(dossier.tagName).toBe('BUTTON');
    expect(dossier.getAttribute('aria-expanded')).toBe('true');
    expect(listRows('agents').map((l) => l.getAttribute('href'))).toEqual([
      '/agents/a1/edit',
      '/agents/a2/edit',
    ]);

    await click(dossier);
    // Replié, le sous-menu n'est pas seulement caché : il n'est pas rendu, donc
    // ses lignes ne restent pas dans l'ordre de tabulation.
    expect(container.querySelector('[data-testid="folder-threads-agents"]')).toBeNull();
  });
});

// ─── 8. Une seule forme de ligne, une largeur qui ne bouge pas ───────────────

describe('toutes les lignes du panneau ont la MÊME forme @cap:installer-et-demarrer/ecran', () => {
  it('rend la même classe de ligne pour chacune, quelle que soit sa profondeur', async () => {
    pathname = '/agents';
    vi.mocked(listSidebarAgentsAction).mockResolvedValue({ ok: true, data: nommees(11, 'Agent') });
    await renderSidebar();

    // Le panneau porte bien les trois sortes de ligne : sans elles, la
    // comparaison ci-dessous ne prouverait rien.
    expect(container.querySelector('[data-testid="inbox-folder-agents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-row-agents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="see-all-agents"]')).not.toBeNull();

    const lignes = [...container.querySelectorAll<HTMLElement>('[data-sidebar-row]')];
    // UNE comparaison, pas quatre assertions : chaque ligne est la forme
    // commune, sa HAUTEUR, puis son état, et rien d'autre. Rayon, fond de
    // survol, fond actif — tout vient du même endroit.
    const attendues = new Set(
      [SIDEBAR_ROW_H.nav, SIDEBAR_ROW_H.recent].flatMap((h) => [
        `${SIDEBAR_ROW_BASE} ${h} ${SIDEBAR_ROW_IDLE}`,
        `${SIDEBAR_ROW_BASE} ${h} ${SIDEBAR_ROW_IDLE_CONTENT}`,
        `${SIDEBAR_ROW_BASE} ${h} ${SIDEBAR_ROW_ACTIVE}`,
      ]),
    );
    for (const forme of new Set(lignes.map((l) => l.className))) {
      expect(attendues.has(forme), `forme de ligne inattendue : « ${forme} »`).toBe(true);
    }
  });

  it('coupe un nom long au lieu d’élargir le panneau', async () => {
    pathname = '/chat';
    vi.mocked(listSidebarProjectsAction).mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'p1',
          name: 'Crée-moi une application de suivi de candidatures assez simple',
          path: 'D:/p1',
          unread: false,
        },
      ],
    });
    await renderSidebar();
    const ligne = listRows('workspaces')[0];
    const libelle = [...(ligne?.querySelectorAll('span') ?? [])].find((s) =>
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

// ─── 9. La carte « Help » : trois endroits, tous dehors ─────────────────────

describe('la carte « Help » du rail @cap:consulter-l-aide/ecran', () => {
  it('reste fermée tant qu’on ne l’ouvre pas', async () => {
    await renderSidebar();
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
    expect(railCell('help').getAttribute('aria-expanded')).toBe('false');
  });

  it('ouvre les TROIS liens du produit, chacun dans un nouvel onglet', async () => {
    // ⚠️ LA PLANCHE NE DESSINE QUE LA CASE, jamais ce qu'elle ouvre. En faire
    // un raccourci vers la documentation seule aurait retiré du produit le
    // serveur Discord et le portail qualité, que la 0.8.11 proposait déjà —
    // une perte que la planche ne demande pas (décision du propriétaire,
    // 20/09/2026).
    //
    // Mutation vérifiée : une des trois lignes retirée de `RAIL_FOOT.help` →
    // ce cas rougit.
    await renderSidebar();
    await click(railCell('help'));
    const carte = container.querySelector('[data-testid="rail-popover"]');
    expect(carte?.getAttribute('aria-label')).toBe('Help');

    const liens = [...(carte?.querySelectorAll('a') ?? [])];
    expect(liens.map((a) => a.textContent?.trim())).toEqual(['Docs', 'Discord', 'Quality portal']);
    // Les adresses sont celles de la table, et la table est la source.
    expect(liens.map((a) => a.getAttribute('href'))).toEqual(RAIL_FOOT.help.map((l) => l.href));
    for (const lien of liens) {
      expect(lien.getAttribute('target'), lien.textContent ?? '').toBe('_blank');
      expect(lien.getAttribute('rel'), lien.textContent ?? '').toBe('noopener noreferrer');
      // La flèche dit qu'on quitte l'application, et elle FERME la ligne.
      const fleche = lien.querySelector('[data-testid="external-arrow"]');
      expect(fleche, lien.textContent ?? '').not.toBeNull();
      expect(lien.lastElementChild, lien.textContent ?? '').toBe(fleche);
    }
  });

  it('n’ouvre qu’UNE carte à la fois, Help ou le compte', async () => {
    // Deux cartes ouvertes en même temps se recouvriraient au bas d'un rail de
    // 72 px.
    //
    // Mutation vérifiée : l'état `Carte` remplacé par deux booléens
    // indépendants → ce cas rougit, les deux cartes coexistent.
    await render(
      <ApprovalsProvider initial={[]}>
        <ChatFoldersProvider
          initial={{
            channels: [],
            running: {},
            runningConversationIds: [],
            externalRuns: 0,
            runsInProgress: 0,
            workConversationsInProgress: 0,
          }}
        >
          <Sidebar workspaces={[]} userMenu={<p>quentin@example.com</p>} />
        </ChatFoldersProvider>
      </ApprovalsProvider>,
    );
    await click(railCell('help'));
    expect(container.querySelector('[data-testid="user-menu"]')).toBeNull();

    await click(container.querySelector('[data-testid="rail-account"]')!);
    expect(container.querySelector('[data-testid="user-menu"]')).not.toBeNull();
    // Celle de Help s'est refermée : une seule carte est rendue.
    expect(container.querySelectorAll('[data-testid="rail-popover"]').length).toBe(1);
    expect(railCell('help').getAttribute('aria-expanded')).toBe('false');
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
    expect(echap.defaultPrevented).toBe(true);
  });
});

// ─── 10. Le compte, et la pile des calques ────────────────────────────────────

describe('le compte au bas du rail @cap:se-connecter/ecran', () => {
  async function renderAvecCompte(): Promise<void> {
    await render(
      <ApprovalsProvider initial={[]}>
        <ChatFoldersProvider
          initial={{
            channels: [],
            running: {},
            runningConversationIds: [],
            externalRuns: 0,
            runsInProgress: 0,
            workConversationsInProgress: 0,
          }}
        >
          <Sidebar workspaces={[]} userMenu={<p>quentin@example.com</p>} />
        </ChatFoldersProvider>
      </ApprovalsProvider>,
    );
  }

  it('n’ouvre le bloc de compte qu’au clic, et il vient du serveur', async () => {
    await renderAvecCompte();
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

  it('se referme à Échap, et PREND la touche en le faisant', async () => {
    await renderAvecCompte();
    await click(container.querySelector('[data-testid="rail-account"]')!);
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

  it('se ferme AVANT le menu qui la porte, parce qu’elle est plus intérieure', async () => {
    // LA règle de la pile (#233) : le dernier calque ouvert prend la touche,
    // pas le plus « modal ». Le menu mobile couvre l'écran, la carte non — et
    // c'est pourtant la carte qui doit se fermer en premier.
    //
    // Mutation vérifiée : `useLayer(true, onClose)` retiré de `RailPopover`
    // → ce cas rougit, le menu se ferme et emporte la carte avec lui.
    await renderAvecCompte();
    await click(container.querySelector('[aria-label="Open menu"]')!);
    const menu = container.querySelector('#primary-nav')!;
    expect(menu.className).toContain('translate-x-0');

    await click(container.querySelector('[data-testid="rail-account"]')!);
    expect(container.querySelector('[data-testid="rail-popover"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[data-testid="rail-popover"]')).toBeNull();
    expect(menu.className).toContain('translate-x-0');

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('#primary-nav')?.className).toContain('-translate-x-full');
  });

  it('se referme au clic DEHORS, et pas au clic dedans', async () => {
    await renderAvecCompte();
    await click(container.querySelector('[data-testid="rail-account"]')!);
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

// ─── Ce qui TOURNE, dit par le rail (#300, #303) ──────────────────────────────
//
// Deux cases du rail portent un point qui bat quand quelque chose avance : Logs
// pour les runs, Work pour les conversations de sa section. Le fait vient de
// l'INSTANTANE du provider que la barre sonde deja (`ChatFoldersProvider`), et
// d'aucune seconde lecture : ces cas montent la barre avec l'instantane voulu et
// lisent ce que le rail en fait.
//
// Le point est `aria-hidden` : ce qu'il montre, le nom de la case le DIT, et
// c'est ce nom que ces cas verifient a cote du point.

/** Le point « ca tourne » d'une case du rail, ou `null` s'il n'y en a pas. */
function pointQuiTourne(key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="rail-${key}-running"]`);
}

describe('le rail dit ce qui tourne @cap:suivre-execution/ecran', () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('allume la case Logs quand un run tourne, et le NOMBRE se dit', async () => {
    pathname = '/agents';
    await renderSidebar([], [], { runsInProgress: 2 });
    const point = pointQuiTourne('logs');
    expect(point).not.toBeNull();
    // Le MEME point que partout ailleurs dans le produit : lime, avec son halo
    // qui bat. Un point vert immobile dirait « fini », pas « en cours ».
    const rond = point!.querySelector('span');
    expect(rond?.className).toContain('bg-agent-vivid');
    expect(rond?.className).toContain('animate-[blip-lime');
    // Le point ne s'annonce pas deux fois : la case le dit en toutes lettres.
    expect(point!.getAttribute('aria-hidden')).toBe('true');
    expect(railCell('logs').getAttribute('aria-label')).toBe('Logs, 2 runs in progress');
  });

  it('n’allume rien sur Logs quand aucun run ne tourne', async () => {
    pathname = '/agents';
    await renderSidebar([], [], { runsInProgress: 0 });
    expect(pointQuiTourne('logs')).toBeNull();
    // Et la case ne se renomme pas pour dire qu'il ne se passe rien : son
    // libelle suffit.
    expect(railCell('logs').getAttribute('aria-label')).toBeNull();
  });

  it('allume la case Work quand UNE conversation de sa section tourne', async () => {
    pathname = '/agents';
    await renderSidebar([], [], { workConversationsInProgress: 1 });
    expect(pointQuiTourne('work')).not.toBeNull();
    // Au SINGULIER : une conversation, pas « 1 conversations ».
    expect(railCell('work').getAttribute('aria-label')).toBe('Work, 1 conversation in progress');
    // Et Logs reste eteint : les deux cases comptent deux choses differentes,
    // et rien ne les fait s'allumer ensemble.
    expect(pointQuiTourne('logs')).toBeNull();
  });

  it('n’allume rien sur Work quand aucune conversation ne tourne', async () => {
    pathname = '/agents';
    await renderSidebar([], [], { workConversationsInProgress: 0, runsInProgress: 3 });
    expect(pointQuiTourne('work')).toBeNull();
    expect(railCell('work').getAttribute('aria-label')).toBeNull();
    // Un run tourne pourtant : il n'est simplement dans aucune conversation de
    // Work - une automatisation, un webhook. Logs le montre, Work non.
    expect(pointQuiTourne('logs')).not.toBeNull();
  });

  it('laisse a Approvals son coin : la ou il y a une pastille, rien ne tourne', async () => {
    pathname = '/agents';
    const uneAttente: PendingApproval[] = [
      {
        id: 'a0',
        jobId: 'j0',
        toolName: 'send_message',
        agentName: null,
        toolInput: {},
        requestedAt: null,
        jobChannel: 'dashboard',
        conversationChannel: 'dashboard',
      },
    ];
    await renderSidebar([], uneAttente, { runsInProgress: 4 });
    // La pastille et le point se posent au MEME endroit. Aucune case n'en
    // porte deux : c'est ce qui rend ce coin lisible.
    expect(railCell('approvals').querySelector('span[class*="bg-err"]')).not.toBeNull();
    expect(pointQuiTourne('approvals')).toBeNull();
    expect(railCell('approvals').getAttribute('aria-label')).toBe('Approvals, 1 pending');
  });
});
