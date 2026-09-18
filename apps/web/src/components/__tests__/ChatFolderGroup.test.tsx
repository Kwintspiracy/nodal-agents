// ChatFolderGroup.test.tsx — le menu Chat À L'ÉCRAN (#135).
//
// Le calcul est prouvé ailleurs (`lib/__tests__/chat-folders.test.ts`). Ce qui
// se prouve ICI est l'autre moitié, celle qu'un test pur ne voit pas : les
// lignes existent, elles mènent quelque part, la pastille ne s'affiche PAS à
// zéro, et le nombre qu'elle porte est plafonné.
//
// Les deux vrais providers sont montés — seules leurs ACTIONS sont simulées.
// Les dossiers traversent donc le même chemin qu'en vrai : un état semé côté
// serveur, un contexte, un rendu.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
// `next/link` demande un routeur qui n'existe pas dans jsdom : une ancre suffit
// à prouver OÙ la ligne mène, qui est la seule chose qu'on lui demande.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions', () => ({ listApprovalsAction: vi.fn() }));
vi.mock('@/lib/conversation-actions.ts', () => ({ getChatFoldersAction: vi.fn() }));
vi.mock('@/lib/folder-threads-actions.ts', () => ({ listFolderThreadsAction: vi.fn() }));

import ChatFolderGroup from '../ChatFolderGroup.tsx';
import SidebarLink from '../ui/SidebarLink';
import { ApprovalsProvider, type PendingApproval } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { chatWaitingTotal, type FolderThread } from '@/lib/chat-folders.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';

let pathname = '/chat';
let search = '';
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

/**
 * Une approbation en attente, réduite à ce que le menu en lit : le canal de son
 * job, et celui de sa CONVERSATION quand elle en a une (#148).
 */
function pending(
  jobChannel: string | null,
  n = 1,
  conversationChannel: string | null = null,
): PendingApproval[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${jobChannel ?? 'none'}${conversationChannel ?? ''}${i}`,
    jobId: `j${jobChannel ?? 'none'}${i}`,
    toolName: 'send_message',
    agentName: null,
    toolInput: {},
    requestedAt: null,
    jobChannel,
    conversationChannel,
  }));
}

async function renderGroup(opts: {
  approvals?: PendingApproval[];
  channels?: string[];
  running?: Record<string, number>;
  externalRuns?: number;
}): Promise<void> {
  await render(
    <ApprovalsProvider initial={opts.approvals ?? []}>
      <ChatFoldersProvider
        initial={{
          channels: opts.channels ?? [],
          running: opts.running ?? {},
          // Le menu ne s'en sert pas : il compte par DOSSIER. Les lignes d'un
          // dossier, elles, s'en servent (#135).
          runningConversationIds: [],
          externalRuns: opts.externalRuns ?? 0,
        }}
      >
        <ChatFolderGroup />
      </ChatFoldersProvider>
    </ApprovalsProvider>,
  );
}

function folderRow(key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="inbox-folder-${key}"]`);
  if (!el) throw new Error(`no row for ${key}`);
  return el;
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  pathname = '/chat';
  search = '';
  document.body.innerHTML = '';
  vi.mocked(listFolderThreadsAction).mockReset();
});

afterEach(async () => {
  // Les providers posent un `setInterval` de 15 s : le démonter évite qu'un
  // test fasse tourner l'horloge d'un autre.
  await act(async () => {
    root.unmount();
  });
});

describe('le groupe de dossiers @cap:reprendre-conversation/ecran', () => {
  it('rend une ligne par dossier, et AUCUNE ne navigue', async () => {
    await renderGroup({ channels: ['telegram', 'slack'] });
    expect(folderRow('telegram').textContent).toContain('Telegram');
    expect(folderRow('slack').textContent).toContain('Slack');
    expect(folderRow('dashboard').textContent).toContain('Nodal chats');
    // Depuis le 19/09/2026, cliquer un dossier le DÉPLIE : sa ligne est un
    // bouton, sans adresse, et « See all » est le seul chemin vers sa liste.
    for (const key of ['telegram', 'slack', 'dashboard']) {
      expect(folderRow(key).tagName, `${key} ne navigue pas`).toBe('BUTTON');
      expect(folderRow(key).getAttribute('href')).toBeNull();
    }
    // Pas de dossier Routines : une automation n'est pas un dialogue.
    expect(container.querySelector('[data-testid="inbox-folder-routines"]')).toBeNull();
  });

  it('ne rend AUCUNE ligne pour un canal sans conversation', async () => {
    await renderGroup({ channels: ['telegram'] });
    expect(container.querySelector('[data-testid="inbox-folder-discord"]')).toBeNull();
  });

  it('rend la ligne MCP dès qu’un run est venu de dehors, et la met en DERNIER', async () => {
    // Quentin, 18/09 : les runs lancés par `/api/agent` ou par le serveur MCP
    // ont leur entrée, au bout de la liste des dossiers.
    await renderGroup({ channels: ['telegram'], externalRuns: 4 });
    expect(folderRow('mcp').textContent).toContain('MCP');
    const ordre = [...container.querySelectorAll('[data-testid^="inbox-folder-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ordre).toEqual(['inbox-folder-dashboard', 'inbox-folder-telegram', 'inbox-folder-mcp']);
  });

  it('ne rend AUCUNE ligne MCP tant qu’aucun run n’est venu de dehors', async () => {
    await renderGroup({ channels: ['telegram'] });
    expect(container.querySelector('[data-testid="inbox-folder-mcp"]')).toBeNull();
  });

  it('écrit sur la pastille le nombre qui attend dans CE dossier', async () => {
    await renderGroup({
      channels: ['telegram', 'slack'],
      approvals: [...pending('telegram', 3), ...pending('slack', 1)],
    });
    expect(folderRow('telegram').textContent).toContain('3');
    expect(folderRow('slack').textContent).toContain('1');
  });

  it('écrit la pastille d’un délégué du tableau des tâches sur le dossier de son fil', async () => {
    // #148. Le job porte `task-board`, qui n'est le dossier de personne ; sa
    // conversation porte Telegram. La ligne du fil s'allumait déjà ; c'est la
    // pastille du dossier qui restait muette au-dessus d'elle.
    await renderGroup({
      channels: ['telegram'],
      approvals: pending('task-board', 2, 'telegram'),
    });
    expect(folderRow('telegram').textContent).toContain('2');
    expect(folderRow('dashboard').textContent).toBe('Nodal chats');
  });

  it('ne rend PAS de pastille à zéro — pas même un « 0 »', async () => {
    await renderGroup({ channels: ['telegram'], approvals: pending('telegram', 0) });
    expect(folderRow('telegram').textContent).toBe('Telegram');
  });

  it('plafonne la pastille à « 9+ » au-delà de neuf', async () => {
    await renderGroup({ channels: ['telegram'], approvals: pending('telegram', 12) });
    expect(folderRow('telegram').textContent).toContain('9+');
    expect(folderRow('telegram').textContent).not.toContain('12');
  });

  it('allume le point d’un dossier où un run tourne, SANS y écrire de nombre', async () => {
    await renderGroup({ channels: ['telegram', 'slack'], running: { telegram: 4 } });
    const avec = folderRow('telegram');
    const sans = folderRow('slack');
    // Le point est le seul <span> rond de la ligne ; il ne porte pas de texte.
    expect(avec.querySelectorAll('span.rounded-full').length).toBe(1);
    expect(sans.querySelectorAll('span.rounded-full').length).toBe(0);
    expect(avec.textContent).toBe('Telegram');
  });

  it('marque le dossier ouvert, et lui seul', async () => {
    search = 'folder=telegram';
    await renderGroup({ channels: ['telegram', 'slack'] });
    expect(folderRow('telegram').getAttribute('aria-current')).toBe('page');
    expect(folderRow('slack').getAttribute('aria-current')).toBeNull();
  });

  it('sur la page des runs programmés, aucun dossier n’est marqué — Scheduled a son propre lien', async () => {
    pathname = '/scheduled';
    await renderGroup({ channels: ['telegram'] });
    expect(folderRow('telegram').getAttribute('aria-current')).toBeNull();
    expect(folderRow('dashboard').getAttribute('aria-current')).toBeNull();
  });
});

describe('le compte porté par le lien « Chat » @cap:reprendre-conversation/ecran', () => {
  it('affiche le total des attentes des dossiers', async () => {
    // `internal` ne dit d'où vient rien : ces cinq-là ne sont dans aucun
    // dossier et ne montent dans aucun total.
    const waiting = [
      ...pending('telegram', 2),
      ...pending('dashboard', 1),
      ...pending('internal', 5),
    ];
    const total = chatWaitingTotal({
      channels: ['telegram'],
      waiting,
      running: {},
      externalRuns: 0,
    });
    expect(total).toBe(3);
    await render(<SidebarLink href="/chat" label="Channels" count={total} isActive={false} />);
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('Channels3');
  });
});

// ─── Le sous-menu d'un dossier (18/09/2026) ──────────────────────────────────

/** Un fil, tel que la lecture le rapporte. Au repos sauf mention contraire. */
function fil(
  key: string,
  title: string,
  etat: { waiting?: boolean; running?: boolean } = {},
): FolderThread {
  return {
    key,
    title,
    href: `/chat/${key}`,
    waiting: etat.waiting ?? false,
    running: etat.running ?? false,
  };
}

/** Ce que la lecture rapporte, dans la forme exacte de l'action. */
function seedThreads(snapshot: Record<string, FolderThread[]>) {
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: snapshot });
}

function threadRows(folder: string): HTMLAnchorElement[] {
  return [
    ...container.querySelectorAll<HTMLAnchorElement>(`[data-testid="folder-thread-${folder}"]`),
  ];
}

describe('les derniers fils d’un dossier @cap:reprendre-conversation/ecran', () => {
  it('ne montre RIEN tant que personne n’a déplié — et ne lit rien non plus', async () => {
    seedThreads({});
    await renderGroup({ channels: ['telegram'] });
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();
    // Replié par défaut : la barre latérale de toutes les pages du tableau de
    // bord ne paie pas la lecture d'un menu que personne n'a ouvert.
    expect(listFolderThreadsAction).not.toHaveBeenCalled();
  });

  it('déplie CINQ fils, dans l’ordre de la liste, chacun vers son fil', async () => {
    seedThreads({
      telegram: [
        fil('t1', 'Invoice for March'),
        fil('t2', 'Book the flight'),
        fil('t3', 'Weekly report'),
        fil('t4', 'Rename the folder'),
        fil('t5', 'Untitled'),
      ],
    });
    await renderGroup({ channels: ['telegram'] });
    await click(container.querySelector('[data-testid="folder-caret-telegram"]')!);

    const rows = threadRows('telegram');
    expect(rows.map((a) => a.textContent)).toEqual([
      'Invoice for March',
      'Book the flight',
      'Weekly report',
      'Rename the folder',
      'Untitled',
    ]);
    expect(rows.map((a) => a.getAttribute('href'))).toEqual([
      '/chat/t1',
      '/chat/t2',
      '/chat/t3',
      '/chat/t4',
      '/chat/t5',
    ]);
  });

  it('ferme le sous-menu par « See all », vers la liste du dossier', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    await click(container.querySelector('[data-testid="folder-caret-telegram"]')!);

    const voirTout = container.querySelector('[data-testid="folder-see-all-telegram"]');
    expect(voirTout?.textContent).toBe('See all');
    // Le MÊME endroit que le nom du dossier au-dessus : cinq fils ne sont pas
    // tous les fils, et rien d'autre ne le dirait.
    expect(voirTout?.getAttribute('href')).toBe('/chat?folder=telegram');
    // Il vient APRÈS les fils. La dernière LIGNE du bloc, donc — le lien vit
    // dans sa ligne, comme toutes les lignes du rail depuis le 19/09/2026.
    const bloc = container.querySelector('[data-testid="folder-threads-telegram"]');
    expect(bloc?.lastElementChild).toBe(voirTout?.closest('[data-sidebar-row]'));
  });

  it('replie ce qu’on vient de déplier', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    const caret = container.querySelector('[data-testid="folder-caret-telegram"]')!;
    expect(caret.getAttribute('aria-expanded')).toBe('false');

    await click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    await click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();
  });

  it('ne lit qu’UNE fois pour TOUS les dossiers', async () => {
    seedThreads({
      telegram: [fil('t1', 'Invoice for March')],
      dashboard: [fil('d1', 'Draft the plan')],
    });
    await renderGroup({ channels: ['telegram'] });
    await click(container.querySelector('[data-testid="folder-caret-telegram"]')!);
    await click(container.querySelector('[data-testid="folder-caret-dashboard"]')!);

    // Une requête par dossier redeviendrait un N+1 au premier canal ajouté.
    expect(listFolderThreadsAction).toHaveBeenCalledTimes(1);
    expect(threadRows('telegram').map((a) => a.textContent)).toEqual(['Invoice for March']);
    expect(threadRows('dashboard').map((a) => a.textContent)).toEqual(['Draft the plan']);
  });

  it('dit qu’un dossier est vide, plutôt que de le laisser muet', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    await click(container.querySelector('[data-testid="folder-caret-dashboard"]')!);
    expect(threadRows('dashboard')).toHaveLength(0);
    expect(container.querySelector('[data-testid="folder-threads-dashboard"]')?.textContent).toBe(
      'Nothing here yetSee all',
    );
  });

  it('DIT qu’il n’a pas pu lire, au lieu d’afficher un dossier vide', async () => {
    vi.mocked(listFolderThreadsAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to load conversations',
    });
    await renderGroup({ channels: ['telegram'] });
    await click(container.querySelector('[data-testid="folder-caret-telegram"]')!);
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')?.textContent).toBe(
      'Failed to load conversationsSee all',
    );
  });
});

// ─── Cliquer un dossier le plie, et rien d'autre (19/09/2026) ────────────────

describe('la ligne d’un dossier PLIE, elle ne mène nulle part @cap:reprendre-conversation/ecran', () => {
  it('déplie au clic sur le libellé, sans naviguer', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    const ligne = folderRow('telegram');
    expect(ligne.getAttribute('aria-expanded')).toBe('false');

    await click(ligne);
    expect(ligne.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).not.toBeNull();
    // La ligne n'a AUCUNE adresse : rien à ouvrir dans un onglet, rien à
    // copier, et aucune navigation au clic.
    expect(ligne.getAttribute('href')).toBeNull();

    await click(ligne);
    expect(ligne.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="folder-threads-telegram"]')).toBeNull();
  });

  it('laisse « See all » être le SEUL chemin vers la liste du dossier', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    await click(folderRow('telegram'));

    const versLaListe = [...container.querySelectorAll('a')].filter(
      (a) => a.getAttribute('href') === '/chat?folder=telegram',
    );
    expect(versLaListe).toHaveLength(1);
    expect(versLaListe[0]?.getAttribute('data-testid')).toBe('folder-see-all-telegram');
  });

  it('donne à « See all » une flèche vers la droite', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    await click(folderRow('telegram'));

    const voirTout = container.querySelector('[data-testid="folder-see-all-telegram"]');
    const fleche = voirTout?.querySelector('[data-testid="see-all-arrow"]');
    expect(fleche).not.toBeNull();
    // En face du libellé, donc au bout de la ligne.
    expect(voirTout?.lastElementChild).toBe(fleche);
  });
});

// ─── Le point d'état d'un fil (19/09/2026) ───────────────────────────────────

/** Les points des fils d'un dossier, dans l'ordre des lignes. */
function threadDots(folder: string): HTMLElement[] {
  return threadRows(folder).map((r) => {
    const dot = r.querySelector<HTMLElement>('[data-testid="thread-dot"]');
    if (!dot) throw new Error(`no dot on a thread row of ${folder}`);
    return dot;
  });
}

describe('le point d’un fil @cap:reprendre-conversation/ecran', () => {
  it('est ROUGE quand une demande attend, ou qu’un run tourne ; gris sinon', async () => {
    seedThreads({
      telegram: [
        fil('t1', 'Waiting on you', { waiting: true }),
        fil('t2', 'Still running', { running: true }),
        fil('t3', 'Both at once', { waiting: true, running: true }),
        fil('t4', 'Nothing to do'),
      ],
    });
    await renderGroup({ channels: ['telegram'] });
    await click(folderRow('telegram'));

    const dots = threadDots('telegram');
    expect(dots.map((d) => d.getAttribute('data-calls'))).toEqual(['yes', 'yes', 'yes', 'no']);
    // La couleur vient du JETON, jamais d'une valeur écrite dans le composant.
    expect(dots[0]?.className).toContain('bg-attention');
    expect(dots[1]?.className).toContain('bg-attention');
    expect(dots[2]?.className).toContain('bg-attention');
    expect(dots[3]?.className).toContain('bg-ink-4');
    expect(dots[3]?.className).not.toContain('bg-attention');
    // Aucun `#D8153F` en dur dans le rendu : le jeton est la seule source.
    expect(container.innerHTML.toLowerCase()).not.toContain('d8153f');
  });

  it('pose le point DEVANT le titre, dans la colonne de l’icône du dossier', async () => {
    seedThreads({ telegram: [fil('t1', 'Invoice for March')] });
    await renderGroup({ channels: ['telegram'] });
    await click(folderRow('telegram'));

    const ligne = threadRows('telegram')[0];
    const dot = ligne?.querySelector('[data-testid="thread-dot"]');
    // Le point ouvre la ligne, et il vit dans une place de 14 px — la largeur
    // de l'icône d'un dossier, au même retrait, donc sur la même verticale.
    expect(ligne?.firstElementChild?.contains(dot ?? null)).toBe(true);
    expect(ligne?.firstElementChild?.className).toContain('h-3.5 w-3.5');
    // Il ne clignote pas : ce n'est pas un `LiveDot`.
    expect(dot?.className).not.toContain('animate');
  });
});

describe('la pastille d’« Approvals » n’a pas bougé @cap:approuver-une-action/ecran', () => {
  it('garde son plafond à 99', async () => {
    await render(<SidebarLink href="/approvals" label="Approvals" pill={120} isActive={false} />);
    expect(container.querySelector('a')?.textContent).toBe('Approvals99+');
  });

  it('écrit le nombre tel quel en deçà', async () => {
    await render(<SidebarLink href="/approvals" label="Approvals" pill={7} isActive={false} />);
    expect(container.querySelector('a')?.textContent).toBe('Approvals7');
  });
});
