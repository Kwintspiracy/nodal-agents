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
  setAgentShellPolicyAction: vi.fn(),
  listApprovalsAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ApprovalsProvider', () => ({
  useApprovals: () => ({ refresh: async () => {} }),
}));

import { toast } from 'sonner';
import ApprovalRequestCard from '../ApprovalRequestCard.tsx';
import {
  resolveApprovalAction,
  setAgentApprovalRuleAction,
  setAgentShellPolicyAction,
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
    ruleChain: [],
    toolDefault: 'require_approval',
    agentWorkspaces: [],
    gateReasons: [],
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

async function monter(approval: Approval, defaultOpen = false): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ApprovalRequestCard approval={approval} defaultOpen={defaultOpen} />);
  });
}

/** Re-rendre LA MÊME instance avec une demande modifiée : c'est ce que fait la
 *  page quand elle se relit après une réponse, la carte gardant sa `key`. */
async function rerendre(approval: Approval, defaultOpen = false): Promise<void> {
  await act(async () => {
    root!.render(<ApprovalRequestCard approval={approval} defaultOpen={defaultOpen} />);
  });
}

/** Un élément par son `data-testid`, ou `null` s'il n'est pas dans le DOM. */
function parTestId(id: string): HTMLElement | null {
  return rendu().querySelector(`[data-testid="${id}"]`);
}

/** Le caret de la ligne d'agent, celui qui plie et déplie. */
async function cliquerLeCaret(): Promise<void> {
  const el = parTestId('approval-request-toggle');
  if (!el) throw new Error('ligne d’agent introuvable');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    expect(lignes[0]!.textContent).toContain('Wins');
    expect(lignes[0]!.textContent).not.toContain('Overridden');

    // Celle que la personne venait d'écrire, écrasée, et dite comme telle.
    expect(lignes[1]!.textContent).toContain('Autonomous');
    expect(lignes[1]!.textContent).toContain('Reviewer C');
    expect(lignes[1]!.textContent).toContain('mcp_playwright__*');
    expect(lignes[1]!.textContent).toContain('Overridden');

    expect(lignes[2]!.textContent).toContain('Overridden');
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
    expect(lignes[0]!.textContent).toContain('Wins');
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

  it('Change sur une règle de dossier GARDE le dossier', async () => {
    // Sans ce renvoi, passer une règle « approuvé dans ce dossier » à
    // Autonomous la rendait GLOBALE pour l'agent, en silence (Reviewer C,
    // passe 1).
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
    await cliquer('Change');
    await act(async () => {
      rendu()
        .querySelector<HTMLButtonElement>('[data-testid="approval-rule-r-folder-block"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(vi.mocked(setAgentApprovalRuleAction).mock.calls[0]?.[0]).toEqual({
      agentId: AGENT,
      toolName: TOOL,
      action: 'block',
      scope: 'agent',
      workspacePath: 'D:/APPS/NodalAI',
    });
  });

  it('une relecture qui ne retrouve pas la demande le DIT', async () => {
    // Fail loud : la lecture est plafonnée à 100 lignes par job. Au-delà, la
    // carte gardait une chaîne périmée en se taisant (Reviewer C, passe 1).
    vi.mocked(listApprovalsAction).mockResolvedValue({ ok: true, data: [] });
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    await cliquer('Change');
    await act(async () => {
      rendu()
        .querySelector<HTMLButtonElement>('[data-testid="approval-rule-r-everyone-block"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain('could not re-read the rules');
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
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
    expect(texte).toContain('needs to execute this tool');
    expect(texte).toContain('Open the report page');
    expect(texte).toContain('External call');
    expect(texte).toContain('third-party tool, MCP server Playwright');
    expect(texte).toContain('Tool input');
  });

  it('le bouclier d’en-tête porte la couleur d’alerte du dessin', async () => {
    // Figma « DeliveryBlock » (nœud 521:7812) : l'icône est peinte en
    // `color/warn`. Rendue en `text-ink-3`, elle se confondait avec le texte
    // secondaire et la carte ne signalait plus rien.
    await monter(demande());
    const bouclier = parTestId('approval-shield');
    expect(bouclier).not.toBeNull();
    expect(bouclier!.getAttribute('class')).toContain('text-warn');
    expect(bouclier!.getAttribute('class')).not.toContain('text-ink-3');
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

  it('une demande tranchée, ouverte, garde son corps et perd ses boutons', async () => {
    await monter(
      demande({
        status: 'approved',
        notes: 'Looked fine',
        resolvedBy: 'quentin',
      } as Partial<Approval>),
    );
    // Elle arrive en Close : le bloc de demande est le seul absent.
    await cliquerLeCaret();
    const texte = rendu().textContent ?? '';
    expect(texte).toContain('Browser run code unsafe');
    expect(texte).toContain('Looked fine');
    expect(texte).toContain('Reason this triggered Approval request');
    expect(bouton('Approve once')).toBeUndefined();
    expect(bouton('Reject')).toBeUndefined();
  });
});

// ─── Open et Close, les deux états du composant ───────────────────────────────
//
// Composant Figma « Approval Card » (nœud 557:6743) : DEUX variantes, Open et
// Close, et rien entre les deux. Close est la MÊME carte moins le seul bloc
// `request` (la ligne d'effet et les arguments). La raison de l'agent,
// « Tool input », les règles et le pied de boutons restent dans les deux.
//
// Quentin, 22/09 : « le design de la carte d'approbation n'est toujours pas
// respecté à la lettre. Il y a pourtant un composant avec deux états, ouvert et
// fermé, clairement décrits. » Le pli à 100 % de #365/#368 inventait un
// troisième état : il est retiré.
//
// Les assertions portent sur le DOM rendu : un bloc absent est ABSENT, pas
// masqué par une classe.

describe('la carte a deux états, Open et Close @cap:approuver-une-action/ecran', () => {
  const TRANCHEE = {
    status: 'approved',
    notes: 'Looked fine',
    resolvedBy: 'quentin',
    ruleChain: CHAINE_346,
  } as Partial<Approval>;

  it('Open rend le bloc de demande : effet, provenance et arguments', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));

    const corps = parTestId('approval-request-body');
    expect(corps).not.toBeNull();
    expect(corps!.textContent).toContain('External call');
    expect(corps!.textContent).toContain('third-party tool, MCP server Playwright');
    expect(corps!.textContent).toContain('await page.click("#go")');
    expect(parTestId('approval-request-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Close cache CE BLOC et RIEN d’autre', async () => {
    await monter(
      demande({
        ruleChain: CHAINE_346,
        agentWorkspaces: [{ label: 'nodal', path: 'D:/APPS/NodalAI' }],
      } as Partial<Approval>),
    );
    await cliquerLeCaret();

    expect(parTestId('approval-request-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(parTestId('approval-request-body')).toBeNull();
    expect(rendu().textContent).not.toContain('External call');
    expect(rendu().textContent).not.toContain('await page.click');

    // Tout le reste tient : la raison, « Tool input », les règles, le pied.
    expect(parTestId('approval-reason')!.textContent).toContain('Open the report page');
    expect(parTestId('approval-tool-input-toggle')).not.toBeNull();
    expect(parTestId('approval-rule-list')).not.toBeNull();
    expect(rendu().textContent).toContain('Reason this triggered Approval request');
    expect(rendu().querySelector('a[href="/jobs/j1"]')!.textContent).toContain('Open Run');
    expect(bouton('Reject')).toBeDefined();
    expect(bouton('Approve for this project')).toBeDefined();
    expect(bouton('Approve once')).toBeDefined();
  });

  it('un reclic sur la ligne d’agent revient à Open', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    await cliquerLeCaret();
    await cliquerLeCaret();

    expect(parTestId('approval-request-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(parTestId('approval-request-body')).not.toBeNull();
  });

  it('une demande en attente arrive en Open, une demande tranchée en Close', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    expect(parTestId('approval-request-body')).not.toBeNull();

    if (root) await act(async () => root!.unmount());
    container?.remove();

    await monter(demande(TRANCHEE));
    expect(parTestId('approval-request-body')).toBeNull();
    // Une archive garde ce qui se relit : sa raison, ses règles, sa note.
    expect(parTestId('approval-reason')!.textContent).toContain('Open the report page');
    expect(parTestId('approval-rule-list')).not.toBeNull();
    expect(parTestId('approval-decision-note')!.textContent).toContain('Looked fine');
    // Et elle n’offre plus de décision, « Open Run » mis à part.
    expect(bouton('Approve once')).toBeUndefined();
    expect(bouton('Reject')).toBeUndefined();
    expect(rendu().querySelector('a[href="/jobs/j1"]')!.textContent).toContain('Open Run');
  });

  it('« Tool input » a son propre pli, replié par défaut et indépendant', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));

    const entree = parTestId('approval-tool-input-toggle')!;
    expect(entree.getAttribute('aria-expanded')).toBe('false');
    expect(rendu().querySelector('pre')).toBeNull();

    await act(async () => {
      entree.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(rendu().querySelector('pre')!.textContent).toContain('page.click');

    // Passer en Close ne le referme pas : les deux plis sont indépendants.
    await cliquerLeCaret();
    expect(parTestId('approval-tool-input-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(rendu().querySelector('pre')).not.toBeNull();
  });

  it('l’en-tête porte la pastille de statut, et plus « View job »', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    expect(rendu().textContent).toContain('pending');
    expect(rendu().textContent).not.toContain('View job');

    if (root) await act(async () => root!.unmount());
    container?.remove();

    await monter(demande(TRANCHEE));
    expect(rendu().textContent).toContain('approved');
    expect(rendu().textContent).not.toContain('View job');
  });

  it('le titre des règles est du texte courant, pas du mono', async () => {
    // Dessin : Body/13 en `ink`. En `text-mono-11 text-ink` le titre passait
    // pour une étiquette technique au-dessus de sa propre liste.
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    const titre = [...rendu().querySelectorAll('p')].find(
      (n) => n.textContent === 'Reason this triggered Approval request',
    );
    expect(titre).toBeDefined();
    expect(titre!.getAttribute('class')).toContain('text-body-13');
    expect(titre!.getAttribute('class')).not.toContain('mono');
  });

  it('`defaultOpen` ouvre une demande tranchée, c’est ce que `?show=` demande', async () => {
    await monter(demande(TRANCHEE), true);

    expect(parTestId('approval-request-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(parTestId('approval-request-body')).not.toBeNull();
    expect(parTestId('approval-decision-note')!.textContent).toContain('Looked fine');
  });

  it('répondue sous les yeux, la carte passe en Close sans attendre une navigation', async () => {
    // L'onglet All garde la MÊME instance de carte quand la page se relit après
    // une réponse : même `key`, statut nouveau.
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    expect(parTestId('approval-request-body')).not.toBeNull();

    await rerendre(demande(TRANCHEE));

    expect(parTestId('approval-request-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(parTestId('approval-request-body')).toBeNull();
    expect(parTestId('approval-decision-note')!.textContent).toContain('Looked fine');
  });

  it('une QUESTION porte sa question et ses options dans la ligne de raison', async () => {
    const entree = { question: 'Which branch do I target?', options: ['main', 'develop'] };

    await monter(demande({ kind: 'question', toolInput: entree } as Partial<Approval>));
    expect(parTestId('approval-reason')!.textContent).toContain('develop');
    // Une question n'a ni effet ni arguments : le bloc de demande n'existe pas.
    expect(parTestId('approval-request-body')).toBeNull();
    expect(rendu().textContent).toContain('Which branch do I target?');

    if (root) await act(async () => root!.unmount());
    container?.remove();

    await monter(
      demande({
        kind: 'question',
        toolInput: entree,
        status: 'approved',
        answer: 'main',
      } as Partial<Approval>),
    );
    expect(parTestId('approval-decision-note')!.textContent).toContain('Answered: main');
    expect(rendu().querySelector('a[href="/jobs/j1"]')!.textContent).toContain('Open Run');
  });
});

// ─── Ce que la revue a trouvé ─────────────────────────────────────────────────

describe('la carte ne perd ni son échéance ni sa garde @cap:approuver-une-action/ecran', () => {
  it('une QUESTION en attente montre encore quand elle expire', async () => {
    // Reviewer C, C1 : la ligne d'horodatage vivait dans le bloc `request`, que
    // Close cache et qu'une question n'a jamais. Une question ouverte perdait
    // alors sa date d'expiration DANS LES DEUX ÉTATS, et rien ne le disait.
    await monter(
      demande({
        kind: 'question',
        toolInput: { question: 'Which branch do I target?', options: ['main'] },
        requestedAt: new Date('2026-09-21T08:00:00.000Z'),
        expiresAt: new Date('2026-09-21T09:00:00.000Z'),
      } as Partial<Approval>),
    );
    expect(parTestId('approval-timing')!.textContent).toContain('requested');
    expect(parTestId('approval-timing')!.textContent).toContain('expires');
  });

  it('un outil garde son échéance en Close, là où le bloc de demande s’en va', async () => {
    await monter(
      demande({
        ruleChain: CHAINE_346,
        requestedAt: new Date('2026-09-21T08:00:00.000Z'),
        expiresAt: new Date('2026-09-21T09:00:00.000Z'),
      } as Partial<Approval>),
    );
    await cliquerLeCaret();
    expect(parTestId('approval-request-body')).toBeNull();
    expect(parTestId('approval-timing')!.textContent).toContain('expires');
  });

  it('une demande EXPIRÉE n’offre aucun bouton de décision', async () => {
    // Reviewer C, Q10 : aucun test ne montait de carte `expired`, donc un garde
    // qui aurait laissé passer ce statut serait resté vert.
    await monter(
      demande({
        status: 'expired',
        ruleChain: CHAINE_346,
        agentWorkspaces: [{ label: 'nodal', path: 'D:/APPS/NodalAI' }],
      } as Partial<Approval>),
    );
    expect(bouton('Approve once')).toBeUndefined();
    expect(bouton('Approve for this project')).toBeUndefined();
    expect(bouton('Reject')).toBeUndefined();
    expect(rendu().querySelector('textarea')).toBeNull();
    // Le pied reste, avec le seul lien qui vaille encore.
    expect(rendu().querySelectorAll('a[href="/jobs/j1"]')).toHaveLength(1);
    expect(rendu().textContent).toContain('expired');
  });

  it('« Open Run » n’est rendu qu’une fois, en Open comme en Close', async () => {
    await monter(demande({ ruleChain: CHAINE_346 } as Partial<Approval>));
    expect(rendu().querySelectorAll('a[href="/jobs/j1"]')).toHaveLength(1);
    await cliquerLeCaret();
    expect(rendu().querySelectorAll('a[href="/jobs/j1"]')).toHaveLength(1);
  });
});

// #464 — la liste de l'agent a retenu la commande : la carte dit POURQUOI, par
// sorte d'action. La commande elle-même est déjà affichée sur la carte.
describe('la carte dit ce que la liste de l’agent a vu (#464) @cap:approuver-une-action/ecran', () => {
  it('nomme chaque sorte d’action lue', async () => {
    await monter(
      demande({
        toolName: 'run_command',
        gateReasons: [
          { category: 'install_software', state: 'ask', details: ['pip install x && rm -rf b'] },
          { category: 'delete_files', state: 'ask', details: ['pip install x && rm -rf b'] },
        ],
      }),
    );
    const items = [...container!.querySelectorAll('[data-testid="approval-shell-reasons"] li')].map(
      (e) => e.textContent,
    );
    expect(items).toEqual(['Install software or packages', 'Delete files or discard changes']);
  });

  it('rien quand la liste n’y est pour rien', async () => {
    await monter(demande());
    expect(container!.querySelector('[data-testid="approval-shell-reasons"]')).toBeNull();
  });
});

// #470 — « Never for this agent » : refuser ET ne plus jamais le demander pour
// ces sortes d'action (Quentin, 24/09 : il cherchait Never sur la carte). Le
// réglage d'abord, la réponse ensuite : un réglage non écrit laisse la
// demande en attente.
describe('« Never for this agent » (#470) @cap:approuver-une-action/ecran', () => {
  const retenue = () =>
    demande({
      toolName: 'run_command',
      agentId: AGENT,
      agentName: 'Excel',
      gateReasons: [
        { category: 'inline_code', state: 'ask', details: ['python -c "x()" && rm -rf out'] },
        { category: 'delete_files', state: 'ask', details: ['python -c "x()" && rm -rf out'] },
      ],
    });

  const confirmer = async (): Promise<void> => {
    await act(async () => {
      parTestId('approval-never')!.click();
    });
    const bouton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Set to Never and reject',
    );
    if (!bouton) throw new Error('no confirm button');
    await act(async () => {
      bouton.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it("n'existe que sur une carte que la liste de l'agent a retenue", async () => {
    await monter(demande());
    expect(parTestId('approval-never')).toBeNull();
    await act(async () => root!.unmount());
    container!.remove();
    await monter(retenue());
    expect(parTestId('approval-never')).not.toBeNull();
  });

  it('dit ce qui change, puis passe chaque sorte à Never AVANT de refuser', async () => {
    vi.mocked(setAgentShellPolicyAction).mockResolvedValue({ ok: true, data: {} as never });
    await monter(retenue());
    await act(async () => {
      parTestId('approval-never')!.click();
    });
    expect(document.body.querySelector('[data-testid="approval-never-changes"]')?.textContent).toBe(
      'Run code written into a command: Ask me → NeverDelete files or discard changes: Ask me → Never',
    );
    await act(async () => {
      [...document.body.querySelectorAll('button')]
        .find((b) => b.textContent === 'Set to Never and reject')!
        .click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(vi.mocked(setAgentShellPolicyAction).mock.calls.map((c) => c[0])).toEqual([
      { agentId: AGENT, category: 'inline_code', state: 'never' },
      { agentId: AGENT, category: 'delete_files', state: 'never' },
    ]);
    expect(vi.mocked(resolveApprovalAction).mock.calls.map((c) => c[0])).toEqual([
      {
        approvalRequestId: 'a1',
        decision: 'reject',
        // The agent reads WHY (run 2fb6bfca): a Never, on what, and not to work around it.
        notes:
          'The owner answered Never: this agent may not run code written into a command (python -c "x()" && rm -rf out); ' +
          'delete files or discard changes (python -c "x()" && rm -rf out), now or later. ' +
          'Do not look for another way to do it; report what you could not do.',
      },
    ]);
    const derniereEcriture = Math.max(
      ...vi.mocked(setAgentShellPolicyAction).mock.invocationCallOrder,
    );
    expect(vi.mocked(resolveApprovalAction).mock.invocationCallOrder[0]).toBeGreaterThan(
      derniereEcriture,
    );
  });

  it('un réglage non écrit ne refuse rien : la demande reste en attente, et la carte le dit', async () => {
    vi.mocked(setAgentShellPolicyAction).mockResolvedValue({
      ok: false,
      code: 'forbidden',
      message: 'Only the workspace owner can change what an agent may do with a shell.',
    } as never);
    await monter(retenue());

    await confirmer();

    expect(vi.mocked(resolveApprovalAction)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls.map((c) => c[0])).toEqual([
      'Setting not saved: Only the workspace owner can change what an agent may do with a shell. The approval stays pending.',
    ]);
  });
});
