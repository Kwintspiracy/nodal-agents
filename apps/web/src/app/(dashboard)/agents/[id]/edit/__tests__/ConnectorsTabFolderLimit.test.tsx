// ConnectorsTabFolderLimit.test.tsx — issue #401, puis #917 : faire confiance à
// un serveur MCP depuis l'onglet Connectors écrit la ligne du serveur, et ne
// touche jamais une ligne confinée à un dossier (elles coexistent, 0156).
//
// Assertions sur le texte rendu et sur l'objet envoyé à l'action, jamais sur un
// compteur d'appels (invariant #5).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Rule = {
  id: string;
  toolName: string;
  action: string;
  conditionJson: { workspacePath?: string } | null;
  workspaceLabel: string | null;
};

type RulePayload = {
  agentId: string;
  toolName: string;
  action: string;
  scope?: string;
};

const actions = vi.hoisted(() => ({
  listAgentApprovalRulesAction: vi.fn(async (_agentId: string) => ({
    ok: true as const,
    data: [] as Rule[],
  })),
  setAgentApprovalRuleAction: vi.fn(async (_raw: RulePayload) => ({
    ok: true as const,
    data: undefined,
  })),
  setAgentConnectorAssignmentAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
  setAgentMcpServerAssignmentAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
}));

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: ConnectorsTabContent } = await import('../ConnectorsTabContent.tsx');

const AGENT_ID = '44444444-4444-4444-8444-444444444444';

// `cogni-cortex` → `cogni_cortex__*`, le motif que l'onglet écrit.
const MCP_SERVER = {
  mcpServerId: 'm1',
  slug: 'cogni-cortex',
  label: 'Cogni Cortex',
  assigned: false,
  enabledTools: null,
  availableTools: [{ name: 'read_page', description: 'Read one page.' }],
};

let container: HTMLDivElement;
let root: Root;

async function render(rules: Rule[]): Promise<void> {
  actions.listAgentApprovalRulesAction.mockImplementation(async () => ({
    ok: true as const,
    data: rules,
  }));
  actions.setAgentApprovalRuleAction.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ConnectorsTabContent
        agentId={AGENT_ID}
        connectors={[]}
        mcpServers={[MCP_SERVER] as never}
      />,
    );
  });
  // La lecture des règles se résout après le montage.
  await act(async () => {});
}

// Le corps du document est PARTAGÉ : les boîtes sortent par un portail, et un
// rendu laissé en place ferait lire à l'assertion suivante un dialogue ouvert
// par le test d'avant.
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

function clickByText(text: string): void {
  const el = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
  if (!el) throw new Error(`No button labelled "${text}" on screen`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function clickByAriaLabel(label: string): void {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`No button with aria-label "${label}" on screen`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Coche « For all my agents, not only this one » dans la boîte de confiance. */
function cocherTousLesAgents(): void {
  const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error('No checkbox in the trust dialog');
  act(() => {
    input.click();
  });
}

/**
 * Attache le serveur depuis le picker, puis répond « oui » à la confiance.
 * `tousLesAgents` coche la case avant de répondre : c'est le chemin
 * `scope: 'entity'`, celui que la première revue ne voyait couvert nulle part.
 */
function attacherEtFaireConfiance(tousLesAgents = false): void {
  clickByText('+ Attach connectors');
  clickByAriaLabel('Attach');
  if (tousLesAgents) cocherTousLesAgents();
  clickByText('Trust it');
}

describe("faire confiance à un serveur depuis l'onglet Connectors écrit la ligne du serveur (#917) @cap:approuver-une-action/ecran", () => {
  // Avant #917, la ligne du serveur et une ligne de dossier pouvaient être la
  // même ligne, d'où une boîte « Remove the folder limit? ». Elles coexistent
  // maintenant : la confiance écrit la ligne du serveur (et le serveur
  // réécrit celles de ses outils), sans rien demander de plus.
  it('pour cet agent : la ligne du serveur, sans boîte en plus', async () => {
    await render([]);
    attacherEtFaireConfiance();
    await act(async () => {});

    expect(document.body.textContent ?? '').not.toContain('Remove the folder limit?');
    expect(actions.setAgentApprovalRuleAction.mock.calls.map((c) => c[0])).toEqual([
      {
        agentId: AGENT_ID,
        toolName: 'cogni_cortex__*',
        action: 'auto_approve',
        scope: 'agent',
      },
    ]);
  });

  it('« pour tous mes agents » envoie la portée entité', async () => {
    await render([]);
    attacherEtFaireConfiance(true);
    await act(async () => {});
    expect(actions.setAgentApprovalRuleAction.mock.calls.map((c) => c[0])).toEqual([
      {
        agentId: AGENT_ID,
        toolName: 'cogni_cortex__*',
        action: 'auto_approve',
        scope: 'entity',
      },
    ]);
  });
});
