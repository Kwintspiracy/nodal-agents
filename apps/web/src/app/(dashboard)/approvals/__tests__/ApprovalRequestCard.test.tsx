// ApprovalRequestCard — la carte d'approbation redessinée (issue #346).
//
// CE QUE CE FICHIER PROUVE, et pourquoi il existe : le 21/09, Quentin a répondu
// « Always for this server » sur un outil ; la règle a été écrite, une règle
// « Everyone » plus précise a continué de demander, et la carte n'en a rien dit.
// La carte montre donc maintenant les règles qui ont joué, dans l'ordre de la
// porte, la gagnante marquée — et une règle ne se change plus que par sa propre
// ligne.
//
// Les assertions portent sur le DOM rendu, jamais sur des compteurs d'appels :
// ce qu'on vérifie est ce qu'une personne lit et clique.

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
vi.mock('@/lib/actions.ts', () => ({
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
  listApprovalsAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ApprovalsProvider', () => ({
  useApprovals: () => ({ refresh: async () => {} }),
}));

import ApprovalRequestCard from '../ApprovalRequestCard.tsx';
import {
  resolveApprovalAction,
  setAgentApprovalRuleAction,
  listApprovalsAction,
} from '@/lib/actions.ts';

type Approval = Parameters<typeof ApprovalRequestCard>[0]['approval'];

const AGENT = 'ag-1';
const TOOL = 'mcp_playwright__browser_run_code_unsafe';

function demande(over: Partial<Approval> = {}): Approval {
  return {
    id: 'a1',
    jobId: 'j1',
    agentId: AGENT,
    agentName: 'Reviewer C',
    agentSlug: 'reviewer-c',
    toolName: TOOL,
    toolInput: { code: 'await page.click("#go")', purpose: 'Open the report page' },
    kind: 'approval',
    answer: null,
    status: 'pending',
    requestedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    notes: null,
    jobTask: null,
    jobChannel: 'dashboard',
    conversationId: null,
    conversationChannel: 'dashboard',
    rootChannel: null,
    rootJobId: null,
    explanation: {
      what: 'Browser run code unsafe via Playwright',
      effect: 'external',
      effectLabel: 'External call',
      target: null,
      provenance: { kind: 'mcp', slug: 'mcp_playwright', name: 'Playwright' },
      purpose: 'Open the report page',
      args: [{ key: 'code', value: 'await page.click("#go")', truncated: false, fullLength: 23 }],
      impact: null,
    },
    mcpRulePattern: 'mcp_playwright__*',
    ruleChain: [],
    toolDefault: 'require_approval',
    agentWorkspaces: [],
    ...over,
  } as unknown as Approval;
}

/** Les trois règles réelles du 21/09, dans l'ordre que la porte leur donne. */
const CHAINE_346 = [
  {
    id: 'r-everyone',
    toolName: TOOL,
    action: 'require_approval' as const,
    agentId: null,
    scope: 'entity' as const,
    tier: 'entity-tool' as const,
    workspacePath: null,
    workspaceLabel: null,
    wins: true,
  },
  {
    id: 'r-agent-server',
    toolName: 'mcp_playwright__*',
    action: 'auto_approve' as const,
    agentId: AGENT,
    scope: 'agent' as const,
    tier: 'agent-server' as const,
    workspacePath: null,
    workspaceLabel: null,
    wins: false,
  },
  {
    id: 'r-entity-all',
    toolName: '*',
    action: 'auto_approve' as const,
    agentId: null,
    scope: 'entity' as const,
    tier: 'entity-all' as const,
    workspacePath: null,
    workspaceLabel: null,
    wins: false,
  },
];

// jsdom ne fournit pas `CSS.supports`, que le `Select` du design system lit au
// montage pour decider s'il synchronise ses legendes (customizable select).
const cssStub = { supports: () => false } as unknown as typeof globalThis.CSS;
if (typeof globalThis.CSS?.supports !== 'function') {
  globalThis.CSS = cssStub;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function monter(approval: Approval): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ApprovalRequestCard approval={approval} />);
  });
}

function rendu(): HTMLDivElement {
  if (!container) throw new Error('rien monté');
  return container;
}

function lignesDeRegles(): HTMLElement[] {
  const liste = rendu().querySelector('[data-testid="approval-rule-list"]');
  return [...(liste?.children ?? [])] as HTMLElement[];
}

function bouton(texte: string): HTMLButtonElement | undefined {
  return [...rendu().querySelectorAll('button')].find((b) => b.textContent?.trim() === texte);
}

async function cliquer(texte: string): Promise<void> {
  const el = bouton(texte);
  if (!el) throw new Error(`bouton introuvable : ${texte}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveApprovalAction).mockResolvedValue({
    ok: true,
    data: { jobId: 'j1', decision: 'approve', answer: null },
  });
  vi.mocked(setAgentApprovalRuleAction).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(listApprovalsAction).mockResolvedValue({ ok: true, data: [] });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('la carte dit quelle règle a décidé @cap:approuver-une-action/ecran', () => {
  it('rend la chaîne dans l’ordre, la première gagnante et les autres écrasées', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));

    const lignes = lignesDeRegles();
    expect(lignes.map((l) => l.getAttribute('data-testid'))).toEqual([
      'approval-rule-r-everyone',
      'approval-rule-r-agent-server',
      'approval-rule-r-entity-all',
    ]);

    // La gagnante : la règle Everyone qui NOMME l'outil, celle que la carte
    // taisait le 21/09. Elle porte « Ask first » et « wins ».
    expect(lignes[0]!.textContent).toContain('Ask first');
    expect(lignes[0]!.textContent).toContain('Everyone');
    expect(lignes[0]!.textContent).toContain(TOOL);
    expect(lignes[0]!.textContent).toContain('wins');
    expect(lignes[0]!.textContent).not.toContain('overridden');

    // Celle que la personne venait d'écrire, écrasée, et dite comme telle.
    expect(lignes[1]!.textContent).toContain('Autonomous');
    expect(lignes[1]!.textContent).toContain('Reviewer C');
    expect(lignes[1]!.textContent).toContain('mcp_playwright__*');
    expect(lignes[1]!.textContent).toContain('overridden');

    expect(lignes[2]!.textContent).toContain('overridden');
    expect(rendu().textContent).toContain('Reason this triggered Approval request');
  });

  it('nomme le dossier d’une règle conditionnée', async () => {
    await monter(
      demande({
        ruleChain: [
          {
            id: 'r-folder',
            toolName: TOOL,
            action: 'auto_approve',
            agentId: AGENT,
            scope: 'agent',
            tier: 'agent-tool-in-folder',
            workspacePath: 'D:/APPS/NodalAI',
            workspaceLabel: 'nodal',
            wins: true,
          },
        ],
      } as Partial<Approval>),
    );
    expect(lignesDeRegles()[0]!.textContent).toContain('Reviewer C \u00b7 in nodal');
  });

  it('sans aucune règle, montre la posture propre de l’outil', async () => {
    await monter(demande());
    const lignes = lignesDeRegles();
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.getAttribute('data-testid')).toBe('approval-rule-tool-default');
    expect(lignes[0]!.textContent).toContain('Tool default');
    expect(lignes[0]!.textContent).toContain('Ask first');
    expect(lignes[0]!.textContent).toContain('wins');
  });

  it('Change remplace le bouton par le sélecteur et enregistre au bon scope', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));

    // Avant : un bouton, pas de sélecteur.
    expect(rendu().querySelector('[data-testid="approval-rule-r-everyone-change"]')).not.toBeNull();
    expect(
      rendu().querySelector('[data-testid="approval-rule-r-everyone-auto_approve"]'),
    ).toBeNull();

    await cliquer('Change');

    const autonome = rendu().querySelector<HTMLButtonElement>(
      '[data-testid="approval-rule-r-everyone-auto_approve"]',
    );
    expect(autonome).not.toBeNull();
    expect(rendu().querySelector('[data-testid="approval-rule-r-everyone-change"]')).toBeNull();

    await act(async () => {
      autonome!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Une ligne Everyone écrit une règle d'entité, sur SON motif d'outil.
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: AGENT,
      toolName: TOOL,
      action: 'auto_approve',
      scope: 'entity',
    });
    // Et changer une règle NE RÉPOND PAS : la demande attend toujours.
    expect(vi.mocked(resolveApprovalAction)).not.toHaveBeenCalled();
    expect(bouton('Approve once')).toBeDefined();
  });

  it('une ligne d’agent écrit une règle d’agent', async () => {
    await monter(demande({ ruleChain: [CHAINE_346[1]!] } as Partial<Approval>));
    await cliquer('Change');
    await act(async () => {
      rendu()
        .querySelector<HTMLButtonElement>('[data-testid="approval-rule-r-agent-server-block"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: AGENT,
      toolName: 'mcp_playwright__*',
      action: 'block',
      scope: 'agent',
    });
  });
});

describe('approuver pour ce dossier @cap:approuver-une-action/ecran', () => {
  it('le bouton n’existe pas quand l’agent n’a aucun dossier', async () => {
    await monter(demande());
    expect(rendu().querySelector('[data-testid="approval-approve-project"]')).toBeNull();
    expect(rendu().querySelector('[data-testid="approval-folder-select"]')).toBeNull();
  });

  it('avec un seul dossier, il existe et n’offre aucun choix', async () => {
    await monter(demande({ agentWorkspaces: [{ label: 'nodal', path: 'D:/APPS/NodalAI' }] }));
    expect(rendu().querySelector('[data-testid="approval-approve-project"]')).not.toBeNull();
    expect(rendu().querySelector('[data-testid="approval-folder-select"]')).toBeNull();

    await cliquer('Approve for this project');
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: AGENT,
      toolName: TOOL,
      action: 'auto_approve',
      scope: 'agent',
      workspacePath: 'D:/APPS/NodalAI',
    });
    expect(vi.mocked(resolveApprovalAction).mock.calls[0]?.[0]).toEqual({
      approvalRequestId: 'a1',
      decision: 'approve',
    });
  });

  it('avec deux dossiers, le choix est offert et c’est LUI qui part', async () => {
    await monter(
      demande({
        agentWorkspaces: [
          { label: 'nodal', path: 'D:/APPS/NodalAI' },
          { label: 'notes', path: 'D:/APPS/Notes' },
        ],
      }),
    );
    const select = rendu().querySelector<HTMLSelectElement>(
      '[data-testid="approval-folder-select"]',
    );
    expect(select).not.toBeNull();
    expect([...select!.options].map((o) => o.textContent)).toEqual(['nodal', 'notes']);

    await act(async () => {
      select!.value = 'D:/APPS/Notes';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await cliquer('Approve for this project');

    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toMatchObject({
      workspacePath: 'D:/APPS/Notes',
    });
  });

  it('une règle non écrite laisse la demande en attente', async () => {
    vi.mocked(setAgentApprovalRuleAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to save approval rule',
    });
    await monter(demande({ agentWorkspaces: [{ label: 'nodal', path: 'D:/APPS/NodalAI' }] }));
    await cliquer('Approve for this project');
    expect(vi.mocked(resolveApprovalAction)).not.toHaveBeenCalled();
  });
});

describe('ce que la carte écrit, en anglais @cap:approuver-une-action/ecran', () => {
  it('titre lisible, raison de l’agent, effet et provenance', async () => {
    await monter(demande());
    const texte = rendu().textContent ?? '';
    expect(texte).toContain('Browser run code unsafe');
    expect(texte).toContain('requested use of');
    expect(texte).toContain('Open the report page');
    expect(texte).toContain('External call');
    expect(texte).toContain('third-party tool, MCP server Playwright');
    expect(texte).toContain('Tool input');
  });

  it('dit en anglais que l’agent n’a pas donné de raison', async () => {
    await monter(
      demande({
        explanation: { ...demande().explanation, purpose: null },
      } as Partial<Approval>),
    );
    const texte = rendu().textContent ?? '';
    expect(texte).toContain('The agent did not say why.');
    expect(texte).not.toContain('expliqu');
  });

  it('n’offre plus aucun « Always », et la décision tient en trois boutons', async () => {
    await monter(demande({ agentWorkspaces: [{ label: 'nodal', path: 'D:/APPS/NodalAI' }] }));
    const texte = rendu().textContent ?? '';
    expect(texte).not.toContain('Always');
    expect(texte).not.toContain('For all my agents');
    expect(bouton('Reject')).toBeDefined();
    expect(bouton('Approve for this project')).toBeDefined();
    expect(bouton('Approve once')).toBeDefined();
  });

  it('une demande déjà tranchée garde son corps et perd ses boutons', async () => {
    await monter(
      demande({
        status: 'approved',
        notes: 'Looked fine',
        resolvedBy: 'quentin',
      } as Partial<Approval>),
    );
    const texte = rendu().textContent ?? '';
    expect(texte).toContain('Browser run code unsafe');
    expect(texte).toContain('Looked fine');
    expect(texte).toContain('Reason this triggered Approval request');
    expect(bouton('Approve once')).toBeUndefined();
    expect(bouton('Reject')).toBeUndefined();
  });
});
