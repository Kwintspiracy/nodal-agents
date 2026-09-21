// rail-pill-clears-on-answer.test.tsx — répondre à une demande FAIT TOMBER la
// pastille du rail tout de suite, QUELLE QUE SOIT la surface qui a répondu.
//
// Le défaut que ce fichier ferme : la pastille de la case « Approvals » compte
// les lignes d'`ApprovalsProvider`, qui se relit toutes les 15 s. On répondait,
// la carte partait de la page, et la barre continuait de réclamer une réponse
// déjà donnée pendant le reste du tour d'horloge.
//
// Il monte les DEUX côtés dans le même provider — la barre qui affiche le
// nombre, et la surface qui répond — parce que c'est justement le lien entre
// les deux qui manquait. Une seule vérité : le provider. Personne ne tient de
// compte à côté.
//
// ⚠️ TROIS SURFACES répondent dans le produit, et chacune a son cas ici : la
// carte de la page Approvals (`ApprovalActions`, avec son échelle entière), la
// carte de question de cette même page (`QuestionActions`), et la carte de
// question DANS LE FIL (`spaces/QuestionCard`). La troisième manquait au
// premier jet (Reviewer C, passe 1) : elle faisait `router.refresh()`, ce qui
// refait le rendu serveur du fil mais ne touche pas un état client.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactNode, type ReactElement } from 'react';
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
vi.mock('../VersionBadge', () => ({ default: () => null }));
vi.mock('../WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../NotificationsBell', () => ({ default: () => null }));
vi.mock('../ui/ThemeToggle', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Sidebar from '../Sidebar.tsx';
import { ApprovalsProvider, type PendingApproval } from '../ApprovalsProvider';
import { ChatFoldersProvider } from '../ChatFoldersProvider';
import {
  listApprovalsAction,
  resolveApprovalAction,
  setAgentApprovalRuleAction,
} from '@/lib/actions';
import { getChatFoldersAction } from '@/lib/conversation-actions.ts';
import { listFolderThreadsAction } from '@/lib/folder-threads-actions.ts';
import { listSidebarProjectsAction } from '@/lib/project-actions.ts';
import {
  listSidebarAgentsAction,
  listSidebarCronAction,
  listSidebarWebhooksAction,
  listSidebarRecentApprovalsAction,
} from '@/lib/sidebar-actions.ts';
import ApprovalActions from '@/app/(dashboard)/approvals/ApprovalActions.tsx';
import QuestionActions from '@/app/(dashboard)/approvals/QuestionActions.tsx';
import QuestionCard from '@/app/(dashboard)/spaces/QuestionCard.tsx';

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

/** La barre ET la surface de décision qu'on veut éprouver, dans UN provider. */
async function monter(surface: ReactElement, attentes: PendingApproval[] = [ATTENTE]) {
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
          {surface}
        </ChatFoldersProvider>
      </ApprovalsProvider>,
    );
  });
}

/** La carte de la page Approvals — l'échelle entière. */
function carteApprobation(agentId: string | null = null): ReactElement {
  return (
    <ApprovalActions
      approvalId={ATTENTE.id}
      toolName={ATTENTE.toolName}
      agentId={agentId}
      mcpRulePattern={null}
      mcpServerName={null}
    />
  );
}

/** La carte de question DU FIL, celle qui vit dans `spaces`. */
function carteDuFil(): ReactElement {
  return (
    <QuestionCard
      prompt="Where should I write the summary?"
      options={['The repo README']}
      question={{ approvalRequestId: ATTENTE.id, status: 'pending', answer: null, notes: null }}
    />
  );
}

/** Ce que la case Approvals du rail AFFICHE — libellé, et chiffre s'il y en a. */
function caseApprovals(): string {
  const el = container.querySelector('[data-testid="rail-approvals"]');
  if (!el) throw new Error('rail-approvals absente');
  return el.textContent?.trim() ?? '';
}

/** Cliquer un bouton par son libellé, sous la racine donnée. */
async function cliquerDans(racine: ParentNode, texte: string): Promise<void> {
  const el = [...racine.querySelectorAll('button')].find((b) => b.textContent?.trim() === texte);
  if (!el) throw new Error(`bouton « ${texte} » absent`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Cliquer un bouton de la page. */
async function cliquer(texte: string): Promise<void> {
  await cliquerDans(container, texte);
}

/**
 * Cliquer le bouton de la BOÎTE DE CONFIRMATION, et pas son homonyme de la
 * page : « Always reject » est écrit sur les deux, et le premier trouvé dans le
 * document est celui de la page — le cliquer refermerait la boîte.
 */
async function confirmer(texte: string): Promise<void> {
  const boite = document.body.querySelector('[role="dialog"]');
  if (!boite) throw new Error('aucune boîte de confirmation ouverte');
  await cliquerDans(boite, texte);
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
  vi.mocked(setAgentApprovalRuleAction).mockResolvedValue({ ok: true, data: undefined });
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
    await monter(carteApprobation());
    expect(caseApprovals()).toBe('Approvals1');

    await cliquer('Approve once');

    // Le corps de la demande, pas un compteur d'appels.
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'approve',
    });
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
    await monter(carteApprobation());
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
    await monter(carteApprobation());
    await cliquer('Approve once');
    expect(vi.mocked(listApprovalsAction)).not.toHaveBeenCalled();
    expect(caseApprovals()).toBe('Approvals1');
  });

  it('REJETER la fait tomber aussi — répondre non est une réponse', async () => {
    await monter(carteApprobation());
    // Le premier clic ouvre la zone de motif, le second envoie.
    await cliquer('Reject');
    await cliquer('Confirm rejection');
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'reject',
    });
    expect(caseApprovals()).toBe('Approvals');
  });

  it('TOUJOURS AUTORISER cet outil la fait tomber, après la règle', async () => {
    // Le chemin le plus long de l'échelle : une règle écrite, puis la
    // résolution. La pastille suit la seconde, pas la première.
    await monter(carteApprobation('ag-1'));
    await cliquer('Always for this tool');
    await confirmer('Always allow');
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: 'ag-1',
      toolName: 'send_message',
      action: 'auto_approve',
      scope: 'agent',
    });
    expect(caseApprovals()).toBe('Approvals');
  });

  it('TOUJOURS REJETER la fait tomber, après la règle de blocage', async () => {
    await monter(carteApprobation('ag-1'));
    await cliquer('Always reject');
    await confirmer('Always reject');
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: 'ag-1',
      toolName: 'send_message',
      action: 'block',
    });
    expect(caseApprovals()).toBe('Approvals');
  });

  it('RÉPONDRE À UNE QUESTION de la page la fait tomber', async () => {
    await monter(<QuestionActions approvalId={ATTENTE.id} options={['Yes', 'No']} />);
    await cliquer('Yes');
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'approve',
      answer: 'Yes',
    });
    expect(caseApprovals()).toBe('Approvals');
  });

  it('RÉPONDRE DEPUIS LE FIL la fait tomber — la troisième surface', async () => {
    // Mutation vérifiée : `await refresh();` retiré d'`answerWith()` dans
    // `spaces/QuestionCard` → ce cas rougit, la case reste « Approvals1 ».
    // `router.refresh()` seul ne suffit pas : il refait le rendu serveur du
    // fil, et la pastille est un état client.
    await monter(carteDuFil());
    expect(caseApprovals()).toBe('Approvals1');
    await cliquer('The repo README');
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'approve',
      answer: 'The repo README',
    });
    expect(caseApprovals()).toBe('Approvals');
  });

  it('une lecture qui LÈVE garde le dernier nombre connu, et le dit', async () => {
    // `refresh` est attendue dans la transition de celui qui répond : un rejet
    // qui remonterait lui ferait perdre son toast de succès pour une décision
    // pourtant enregistrée.
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listApprovalsAction).mockRejectedValue(new Error('socket closed'));
    await monter(carteApprobation());
    await cliquer('Approve once');
    expect(caseApprovals()).toBe('Approvals1');
    expect(journal.mock.calls.map((c) => c[0])).toContain(
      '[ApprovalsProvider] listApprovalsAction threw',
    );
    journal.mockRestore();
  });
});
