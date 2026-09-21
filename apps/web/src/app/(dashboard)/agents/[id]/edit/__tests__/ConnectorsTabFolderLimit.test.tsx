// ConnectorsTabFolderLimit.test.tsx — issue #401 : faire confiance à un serveur
// MCP depuis l'onglet Connectors ne peut plus effacer en silence une règle
// confinée à un dossier.
//
// Ce que ça prouve, sur le DOM rendu et sur CE QUI PART au serveur :
//   - quand le motif du serveur porte déjà une limite de dossier, la boîte de
//     #390 s'ouvre, nomme le dossier, et rien n'est écrit tant qu'elle est là ;
//   - confirmer envoie `confirmWidening: true` — le drapeau que l'action
//     gardée exige pour retirer la condition ;
//   - annuler n'écrit RIEN : la règle de dossier reste ce qu'elle était ;
//   - sans limite de dossier, aucune boîte en plus, et l'écriture part sans
//     drapeau, comme avant.
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
  confirmWidening?: boolean;
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

/** Attache le serveur depuis le picker, puis répond « oui » à la confiance. */
function attacherEtFaireConfiance(): void {
  clickByText('+ Attach connectors');
  clickByAriaLabel('Attach');
  clickByText('Trust it');
}

const folderRule: Rule = {
  id: 'r1',
  toolName: 'cogni_cortex__*',
  action: 'auto_approve',
  conditionJson: { workspacePath: 'D:\\APPS\\Dev' },
  workspaceLabel: 'Dev',
};

describe("l'onglet Connectors ne franchit pas une limite de dossier en silence @cap:approuver-une-action/ecran", () => {
  it('nomme le dossier et ne rien écrire tant que la boîte est ouverte', async () => {
    await render([folderRule]);
    attacherEtFaireConfiance();

    const texte = document.body.textContent ?? '';
    expect(texte).toContain('Remove the folder limit?');
    expect(texte).toContain(
      'This rule applies only in Dev today. Saving from here applies your choice everywhere this agent works.',
    );
    // Rien n'est parti : la question précède l'écriture.
    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);
  });

  it('confirmer envoie le drapeau explicite, sur le motif du serveur', async () => {
    await render([folderRule]);
    attacherEtFaireConfiance();
    clickByText('Remove the limit');
    await act(async () => {});

    expect(actions.setAgentApprovalRuleAction.mock.calls.map((c) => c[0])).toEqual([
      {
        agentId: AGENT_ID,
        toolName: 'cogni_cortex__*',
        action: 'auto_approve',
        scope: 'agent',
        confirmWidening: true,
      },
    ]);
  });

  it('annuler laisse la règle de dossier intacte : aucune écriture', async () => {
    await render([folderRule]);
    attacherEtFaireConfiance();
    clickByText('Cancel');
    await act(async () => {});

    expect(actions.setAgentApprovalRuleAction.mock.calls).toEqual([]);
    expect(document.body.textContent ?? '').not.toContain('Remove the folder limit?');
  });

  it('sans limite de dossier, aucune boîte en plus et aucun drapeau', async () => {
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

  it('une limite posée sur UN outil du serveur ne déclenche pas la boîte', async () => {
    // `cogni_cortex__read_page` confiné à Dev n'est pas la ligne que cet onglet
    // remplace : la règle exacte bat le motif dans son dossier (chaîne
    // d'approbation, tier `agent-tool-in-folder`). Avertir là serait faux.
    await render([{ ...folderRule, id: 'r2', toolName: 'cogni_cortex__read_page' }]);
    attacherEtFaireConfiance();
    await act(async () => {});

    expect(document.body.textContent ?? '').not.toContain('Remove the folder limit?');
    expect(actions.setAgentApprovalRuleAction.mock.calls[0]?.[0]).toEqual({
      agentId: AGENT_ID,
      toolName: 'cogni_cortex__*',
      action: 'auto_approve',
      scope: 'agent',
    });
  });
});
