// McpServerSection.test.tsx — la carte du serveur MCP dit ce que le serveur fait (#480).
//
// Elle disait « hand work to this workspace's root agent » (n'importe quel agent
// peut être visé, la racine n'est que le défaut), « external » (lu comme « depuis
// l'extérieur du réseau » : c'est un serveur stdio, aucun port), et taisait le
// plafond de jobs. Le plafond affiché est la constante que le serveur applique
// (#498), pas un nombre recopié.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MCP_MAX_JOBS_IN_FLIGHT } from '@nodal-agents/shared';

const addNodalToClaudeDesktopAction = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    data: { path: DESKTOP_PATH, backupPath: `${DESKTOP_PATH}.bak`, replaced: false },
  })),
);
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  setMcpServerSwitchAction: vi.fn(),
  addNodalToClaudeDesktopAction,
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

const DESKTOP_PATH = 'C:\\Users\\q\\AppData\\Roaming\\Claude\\claude_desktop_config.json';
const CLIENTS = {
  claudeCode:
    'claude mcp add nodal -- "C:\\Program Files\\nodejs\\node.exe" D:\\cli\\index.js mcp serve',
  claudeDesktop: '{\n  "mcpServers": {\n    "nodal": {}\n  }\n}',
  claudeDesktopPath: DESKTOP_PATH,
};

const { default: McpServerSection } = await import('../McpServerSection.tsx');

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(enabled: boolean, clients: typeof CLIENTS | null = CLIENTS) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<McpServerSection initial={{ enabled, isOwner: true, clients }} />);
  });
  return container.querySelector('p')!.textContent!.replace(/\s+/g, ' ');
}

describe('La carte du serveur MCP', () => {
  it('dit que l’agent visé est la racine PAR DÉFAUT, et qu’aucun port n’est ouvert', async () => {
    const texte = await render(false);
    expect(texte).toContain(
      'hand work to an agent of this workspace: the root agent, unless the caller names another.',
    );
    expect(texte).toContain('Nothing is opened to the network.');
    expect(texte).not.toContain('external');
  });

  it('dit le plafond que le serveur applique, lu à la même source', async () => {
    const texte = await render(true);
    expect(texte).toContain(
      `At most ${MCP_MAX_JOBS_IN_FLIGHT} MCP jobs run at once; a finished one frees its place.`,
    );
  });

  it('n’emploie aucun tiret cadratin (règle de copie de l’interface)', async () => {
    expect(await render(true)).not.toContain('—');
  });
});

describe('La carte du serveur MCP, ce que la page Runs montre', () => {
  it('promet le canal et l’étiquette de l’appelant, que la page Runs affiche (originOfRun, run-origin-mcp.test.ts)', async () => {
    const texte = await render(true);
    expect(texte).toContain(
      'Jobs arrive on the Runs page with channel mcp and the label the caller gives.',
    );
    expect(texte).toContain(
      'MCP jobs never get the configuration tools (create agents, skills, connectors, automations); the runner enforces that, not this switch.',
    );
  });
});

describe('La confirmation d’activation', () => {
  it('dit que tout agent de l’espace peut être visé, la racine par défaut, sans tiret cadratin (revue Codex de la PR #521)', async () => {
    await render(false);
    const bouton = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => {
      bouton.click();
    });
    const texte = document.body.textContent!.replace(/\s+/g, ' ');
    expect(texte).toContain(
      'will be able to hand work to an agent of this workspace: the root agent, unless it names another.',
    );
    expect(texte).not.toContain('to your root agent');
    expect(texte).not.toContain('—');
  });
});

describe('Deux clients à la fois, Claude Code ET Claude Desktop (#485) @cap:connecter-un-service/ecran', () => {
  it('montre un bloc par client, avec le texte exact de CETTE install', async () => {
    await render(true);
    const claudeCode = container.querySelector('[data-testid="mcp-client-claude-code"]');
    const desktop = container.querySelector('[data-testid="mcp-client-claude-desktop"]');
    expect(claudeCode?.textContent).toContain(CLIENTS.claudeCode);
    expect(desktop?.textContent).toContain('"mcpServers"');
    expect(desktop?.textContent).toContain(DESKTOP_PATH);
    expect(container.textContent).toContain('Both can be connected at the same time.');
  });

  it('« Add to Claude Desktop » montre l’entrée, dit la copie et le redémarrage, puis écrit', async () => {
    await render(true);
    const bouton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add to Claude Desktop',
    )!;
    await act(async () => {
      bouton.click();
    });
    // Rien n'est écrit avant la confirmation.
    expect(addNodalToClaudeDesktopAction).not.toHaveBeenCalled();
    const dialogue = document.body.textContent!.replace(/\s+/g, ' ');
    expect(dialogue).toContain(DESKTOP_PATH);
    expect(dialogue).toContain('Its other servers are kept, and the file is backed up first.');
    expect(dialogue).toContain('Restart Claude Desktop');

    const confirmer = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    )!;
    await act(async () => {
      confirmer.click();
    });
    expect(addNodalToClaudeDesktopAction).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Added to Claude Desktop. Restart it to connect.');
  });

  it('sans la commande du CLI, la carte le dit au lieu d’inventer une commande', async () => {
    await render(true, null);
    expect(container.querySelector('[data-testid="mcp-client-claude-code"]')).toBeNull();
    expect(container.textContent).toContain('Start Nodal with nodal-agents up');
  });
});
