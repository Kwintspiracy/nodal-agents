// RuntimeShellSetting.test.tsx — l'interrupteur « Shell commands » de la carte
// runtime (#494), sur le DOM rendu.
//
// Ce que ça prouve : un agent Claude Code n'avait aucun réglage qui atteigne sa
// CLI, et l'équipe proposait au propriétaire « j'approuverai » ou « active le
// Yolo ». L'écran porte maintenant LE réglage que le runner lit : ce qui part au
// serveur est vérifié (l'argument de l'action), pas un compteur d'appels.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const actions = vi.hoisted(() => {
  const noop = () => vi.fn(async () => ({ ok: true as const, data: undefined }));
  return {
    setCliRuntimeShellAction: vi.fn(
      async (_raw: {
        agentId: string;
        shell: 'none' | 'auto';
      }): Promise<{ ok: true; data: undefined }> => ({ ok: true, data: undefined }),
    ),
    setCliRuntimeModeAction: noop(),
    setCliDefaultsAction: noop(),
    listKeyModelsAction: noop(),
  };
});

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// La ligne « Diagnostics and defaults » interroge la CLI installée : hors sujet ici.
vi.mock('../CodeTaskProviderRow.tsx', () => ({ default: () => null, ProviderRow: () => null }));

const { ClaudeCodeRuntimeCard } = await import('../AgentComposer.tsx');

const AGENT_ID = '44444444-4444-4444-8444-444444444444';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.setCliRuntimeShellAction.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function render(props: {
  runtime: 'claude-code' | 'codex';
  mode: 'read' | 'write';
  initialShell: 'none' | 'auto';
  extraDisallowed?: string[];
  autoRunPaused?: boolean;
}) {
  act(() => {
    root.render(
      <ClaudeCodeRuntimeCard
        agentId={AGENT_ID}
        runtime={props.runtime}
        mode={props.mode}
        onChangeMode={() => {}}
        initialShell={props.initialShell}
        extraDisallowed={props.extraDisallowed ?? []}
        autoRunPaused={props.autoRunPaused ?? false}
        cliDefaults={null}
        workspaces={[]}
      />,
    );
  });
}

const shellRow = () => document.querySelector('[data-testid="cli-runtime-shell"]');
const shellSwitch = () =>
  document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Shell commands"]');
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

describe('Runtime card, shell commands setting @cap:executer-une-commande/ecran', () => {
  it('Claude Code in write mode: enabling asks first, then sends shell auto', async () => {
    render({ runtime: 'claude-code', mode: 'write', initialShell: 'none' });
    expect(shellRow()?.textContent).toContain('without asking');
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('false');

    act(() => shellSwitch()?.click());
    // Rien n'est envoyé avant la confirmation.
    expect(actions.setCliRuntimeShellAction).not.toHaveBeenCalled();
    // La confirmation dit ce que le shell peut vraiment : pas confiné au
    // dossier de travail (revue Codex de #494).
    expect(document.body.textContent).toContain('not confined to it');

    await act(async () => buttonNamed('Enable shell commands')?.click());
    expect(actions.setCliRuntimeShellAction.mock.calls[0]?.[0]).toEqual({
      agentId: AGENT_ID,
      shell: 'auto',
    });
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('true');
  });

  it('Claude Code, shell on: turning it off sends shell none, with no confirmation', async () => {
    render({ runtime: 'claude-code', mode: 'write', initialShell: 'auto' });
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('true');
    await act(async () => shellSwitch()?.click());
    expect(actions.setCliRuntimeShellAction.mock.calls[0]?.[0]).toEqual({
      agentId: AGENT_ID,
      shell: 'none',
    });
  });

  it('Claude Code in read only: the switch is off and locked, and says why', () => {
    // Stocké 'auto', mais la lecture seule n'a pas de shell : l'écran dit ce
    // que le runner fera, pas ce qui est stocké.
    render({ runtime: 'claude-code', mode: 'read', initialShell: 'auto' });
    expect(shellSwitch()?.disabled).toBe(true);
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(shellRow()?.textContent).toContain('Needs write mode');
  });

  it('Claude Code under the workspace brake: off, locked, and it says the brake is why', () => {
    render({ runtime: 'claude-code', mode: 'write', initialShell: 'auto', autoRunPaused: true });
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(shellSwitch()?.disabled).toBe(true);
    expect(shellRow()?.textContent).toContain('Auto-run is paused');
  });

  it('Claude Code whose shell tools are forbidden elsewhere: shown off, with the reason', () => {
    render({
      runtime: 'claude-code',
      mode: 'write',
      initialShell: 'auto',
      extraDisallowed: ['Bash', 'PowerShell'],
    });
    expect(shellSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(shellRow()?.textContent).toContain('blocked by another restriction');
  });

  it('Codex: no switch, the sandbox rule is stated', () => {
    render({ runtime: 'codex', mode: 'write', initialShell: 'none' });
    expect(shellSwitch()).toBeNull();
    expect(shellRow()?.textContent).toContain('inside its own sandbox');
  });

  it('Codex under the workspace brake: the screen says it does not start, as the runner refuses it', () => {
    render({ runtime: 'codex', mode: 'write', initialShell: 'none', autoRunPaused: true });
    expect(shellRow()?.textContent).toContain('does not start');
    expect(shellRow()?.textContent).not.toContain('inside its own sandbox');
  });
});
