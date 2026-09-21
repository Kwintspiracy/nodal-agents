// rail-pill-clears-on-answer.test.tsx — répondre à une demande FAIT TOMBER la
// pastille du rail tout de suite.
//
// Le défaut que ce fichier ferme : la pastille de la case « Approvals » compte
// les lignes d'`ApprovalsProvider`, qui se relit toutes les 15 s. On approuvait,
// la carte partait de la page, et la barre continuait de réclamer une réponse
// déjà donnée pendant le reste du tour d'horloge.
//
// Il monte les DEUX côtés dans le même provider — la barre qui affiche le
// nombre, et la carte qui répond — parce que c'est justement le lien entre les
// deux qui manquait. Une seule vérité : le provider. Personne ne tient de
// compte à côté.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/approvals',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions', () => ({
  listApprovalsAction: vi.fn(),
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
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
// Les blocs qui ne sont pas le sujet appellent chacun leur action serveur.
vi.mock('@/components/VersionBadge', () => ({ default: () => null }));
vi.mock('@/components/WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('@/components/NotificationsBell', () => ({ default: () => null }));
vi.mock('@/components/ui/ThemeToggle', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Sidebar from '@/components/Sidebar.tsx';
import { ApprovalsProvider, type PendingApproval } from '@/components/ApprovalsProvider';
import { ChatFoldersProvider } from '@/components/ChatFoldersProvider';
import { listApprovalsAction, resolveApprovalAction } from '@/lib/actions';
import { getChatFoldersAction } from '@/lib/conversation-actions.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import {
  listSidebarAgentsAction,
  listSidebarCronAction,
  listSidebarWebhooksAction,
  listSidebarRecentApprovalsAction,
} from '@/lib/sidebar-actions.ts';
import ApprovalActions from '../ApprovalActions.tsx';

let container: HTMLDivElement;
let root: Root;

const ESPACES = [
  { id: 'w1', name: 'Local', slug: 'local', icon: null, active: true },
] as unknown as Parameters<typeof Sidebar>[0]['workspaces'];

const ATTENTE: PendingApproval = {
  id: 'a1',
  jobId: 'j1',
  toolName: 'send_message',
  agentName: 'Alfred',
  toolInput: {},
  requestedAt: null,
  jobChannel: 'dashboard',
  conversationChannel: 'dashboard',
};

/** La barre ET la carte de décision, dans le MÊME provider. */
async function monter(attentes: PendingApproval[]): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ApprovalsProvider initial={attentes}>
        <ChatFoldersProvider
          initial={{
            channels: [],
            running: {},
            runningConversationIds: [],
            externalRuns: 0,
            deliverablesToCheck: [],
            deliverableCheckJobIds: [],
            deliverableCheckConversationIds: [],
            runsInProgress: 0,
            workConversationsInProgress: 0,
          }}
        >
          <Sidebar workspaces={ESPACES} />
          <ApprovalActions
            approvalId={ATTENTE.id}
            toolName={ATTENTE.toolName}
            agentId={null}
            mcpRulePattern={null}
            mcpServerName={null}
          />
        </ChatFoldersProvider>
      </ApprovalsProvider>,
    );
  });
}

/** Ce que la case Approvals du rail AFFICHE — libellé, et chiffre s'il y en a. */
function caseApprovals(): string {
  const el = container.querySelector('[data-testid="rail-approvals"]');
  if (!el) throw new Error('rail-approvals absente');
  return el.textContent?.trim() ?? '';
}

function bouton(texte: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === texte);
  if (!el) throw new Error(`bouton « ${texte} » absent`);
  return el as HTMLButtonElement;
}

async function cliquer(texte: string): Promise<void> {
  const el = bouton(texte);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFolderThreadsAction).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(listSidebarProjectsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarAgentsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarCronAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarWebhooksAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listSidebarRecentApprovalsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(getChatFoldersAction).mockResolvedValue({
    ok: true,
    data: {
      channels: [],
      running: {},
      runningConversationIds: [],
      externalRuns: 0,
      deliverablesToCheck: [],
      deliverableCheckJobIds: [],
      deliverableCheckConversationIds: [],
      runsInProgress: 0,
      workConversationsInProgress: 0,
    },
  });
  // LA RELECTURE NE TROUVE PLUS RIEN : c'est l'état de la base après la
  // réponse, et c'est ce que la barre doit afficher.
  vi.mocked(listApprovalsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(resolveApprovalAction).mockResolvedValue({
    ok: true,
    data: { jobId: 'j1', decision: 'approve', answer: null },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('la pastille du rail tombe dès la réponse @cap:approuver-une-action/ecran', () => {
  it('APPROUVER fait disparaître le nombre, sans attendre le tour de cadence', async () => {
    // Mutation vérifiée : `if (result.ok) await refresh();` retiré de
    // `resolve()` dans `ApprovalActions` → la case reste « Approvals1 ».
    await monter([ATTENTE]);
    expect(caseApprovals()).toBe('Approvals1');

    await cliquer('Approve once');

    // Le corps de la demande, pas un compteur d'appels.
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'approve',
    });
    // Le provider a été RELU, et la case ne porte plus que son nom.
    expect(vi.mocked(listApprovalsAction)).toHaveBeenCalledWith({ status: 'pending' });
    expect(caseApprovals()).toBe('Approvals');
    expect(
      container.querySelector('[data-testid="rail-approvals"]')?.getAttribute('aria-label'),
    ).toBeNull();
  });

  it('relit APRÈS la réponse du serveur, jamais avant', async () => {
    // Relire avant compterait la demande qu'on est en train de fermer, et la
    // pastille resterait à un jusqu'au sondage suivant.
    let luAvantLaReponse = true;
    vi.mocked(resolveApprovalAction).mockImplementation(async () => {
      luAvantLaReponse = vi.mocked(listApprovalsAction).mock.calls.length > 0;
      return { ok: true, data: { jobId: 'j1', decision: 'approve', answer: null } };
    });
    await monter([ATTENTE]);
    await cliquer('Approve once');
    expect(luAvantLaReponse).toBe(false);
    expect(caseApprovals()).toBe('Approvals');
  });

  it('une réponse EN ÉCHEC laisse le nombre en place', async () => {
    // Fail loud : la demande est toujours en attente côté runner, et une
    // pastille qui tomberait quand même mentirait sur l'état de la base.
    vi.mocked(resolveApprovalAction).mockResolvedValue({
      ok: false,
      code: 'runner_unreachable',
      message: 'Runner did not respond',
    });
    await monter([ATTENTE]);
    await cliquer('Approve once');
    expect(vi.mocked(listApprovalsAction)).not.toHaveBeenCalled();
    expect(caseApprovals()).toBe('Approvals1');
  });
});
