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

import ChatFolderGroup from '../ChatFolderGroup.tsx';
import SidebarLink from '../ui/SidebarLink';
import { ApprovalsProvider, type PendingApproval } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import { chatWaitingTotal } from '@/lib/chat-folders.ts';

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

function folderRow(key: string): HTMLAnchorElement {
  const el = container.querySelector<HTMLAnchorElement>(`[data-testid="inbox-folder-${key}"]`);
  if (!el) throw new Error(`no row for ${key}`);
  return el;
}

beforeEach(() => {
  pathname = '/chat';
  search = '';
  document.body.innerHTML = '';
});

afterEach(async () => {
  // Les providers posent un `setInterval` de 15 s : le démonter évite qu'un
  // test fasse tourner l'horloge d'un autre.
  await act(async () => {
    root.unmount();
  });
});

describe('le groupe de dossiers @cap:reprendre-conversation/ecran', () => {
  it('rend une ligne par dossier, chacune vers son endroit', async () => {
    await renderGroup({ channels: ['telegram', 'slack'] });
    expect(folderRow('telegram').textContent).toContain('Telegram');
    expect(folderRow('telegram').getAttribute('href')).toBe('/chat?folder=telegram');
    expect(folderRow('slack').getAttribute('href')).toBe('/chat?folder=slack');
    expect(folderRow('dashboard').textContent).toContain('Nodal chats');
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
    expect(folderRow('mcp').getAttribute('href')).toBe('/chat?folder=mcp');
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
