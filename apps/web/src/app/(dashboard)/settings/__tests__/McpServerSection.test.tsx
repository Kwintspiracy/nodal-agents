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

vi.mock('@/lib/actions.ts', () => ({ setMcpServerSwitchAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: McpServerSection } = await import('../McpServerSection.tsx');

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(enabled: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<McpServerSection initial={{ enabled, isOwner: true }} />);
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
