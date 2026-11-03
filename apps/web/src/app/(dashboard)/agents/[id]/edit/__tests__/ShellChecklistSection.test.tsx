// ShellChecklistSection.test.tsx — what an agent may NOT do with a shell (#464).
//
// What this proves, rendered in jsdom and CLICKED: an agent nobody configured
// shows "Allowed" for downloads and inline code, "Ask me" on the rest (#614); a
// click sends the action the kind of action and the state the owner chose (the
// ARGUMENT, invariant #5), and the row shows it; a refused save puts the row back; a non-owner sees the rows and cannot
// change them. What the engine does with those states is proven in
// packages/tools/src/tests/shell-checklist-gate.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SHELL_POLICY, SHELL_CATEGORIES } from '@nodal-agents/shared';
import ShellChecklistSection from '../ShellChecklistSection.tsx';
import { runCommandsTruth } from '../shell-truth.ts';

type SaveInput = { agentId: string; category: string; state: string };
const setAgentShellPolicyAction = vi.hoisted(() =>
  vi.fn(
    async (
      _raw: SaveInput,
    ): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> => ({
      ok: true,
      data: null,
    }),
  ),
);
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({ setAgentShellPolicyAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

let container: HTMLDivElement;
let root: Root;

async function render(storedPolicy: unknown, isOwner = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ShellChecklistSection agentId={AGENT_ID} storedPolicy={storedPolicy} isOwner={isOwner} />,
    );
  });
}

const button = (category: string, state: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(
    `[data-testid="shell-btn-${category}-${state}"]`,
  );
  if (!el) throw new Error(`no ${category}/${state} button`);
  return el;
};
const pressed = (category: string): string | undefined =>
  ['allow', 'ask', 'never'].find(
    (s) => button(category, s).getAttribute('aria-pressed') === 'true',
  );

beforeEach(() => {
  setAgentShellPolicyAction.mockReset();
  toastError.mockReset();
});

describe('ShellChecklistSection @cap:regler-autonomie/ecran', () => {
  it('an agent nobody configured downloads and runs inline code without asking, and asks for the rest (#614)', async () => {
    await render(null);
    expect(SHELL_CATEGORIES.map((c) => [c, pressed(c)])).toEqual([
      ['inline_code', 'allow'],
      ['delete_files', 'ask'],
      ['install_software', 'ask'],
      ['download', 'allow'],
      ['open_or_send', 'ask'],
      ['stop_programs', 'ask'],
      ['system_settings', 'ask'],
    ]);
    expect(container.textContent).toContain('Run code written into a command');
    expect(container.textContent).toContain('Delete files or discard changes');
    expect(container.textContent).not.toContain('outside its folders');
  });

  // Revue de la PR #618, passe 3 : « Allowed » pour les téléchargements a un
  // périmètre, et les magasins des programmes de modèles en font partie. Il
  // est dit sur la ligne, pas caché.
  it('the download row says where Allowed reaches, the model stores included (#614)', async () => {
    await render(null);
    const row = container.querySelector('[data-testid="shell-row-download"]');
    expect(row?.textContent).toContain(
      'Allowed: into its folders and the model and image stores (comfy, ollama, docker, hf).',
    );
    // Passe 4 : la lecture de la cible est un filet, pas une frontière (#628).
    expect(row?.textContent).toContain(
      'A target it reads elsewhere (curl -o, wget -O…) asks. Not watertight: what programs write on their own (cp, config files) is not bounded, that takes a sandbox.',
    );
  });

  it('says what a reading can promise: a script is read, one it cannot read is code written into a command (#635)', async () => {
    await render(null);
    // A reading of the command is not a sandbox, and the screen does not
    // pretend the agent stays in its folders. Since #635 the scripts a command
    // runs are read too; one that cannot be read follows the inline-code row.
    expect(container.textContent).toContain(
      'Nodal reads each command and the scripts it runs, then runs it, asks you first, or refuses it, at every autonomy level. A script it cannot read counts as code written into a command.',
    );
  });

  // #667 : un agent a imprimé par le shell sans que personne soit consulté.
  // Ce qui atteint l'écran, une imprimante ou quelqu'un a sa ligne, demandée
  // par défaut, y compris pour une liste enregistrée avant elle.
  it('the row for what reaches the screen, a printer or someone asks by default, even on a policy stored before it (#667)', async () => {
    await render({
      inline_code: 'allow',
      delete_files: 'allow',
      install_software: 'allow',
      download: 'allow',
      stop_programs: 'allow',
      system_settings: 'allow',
    });
    const row = container.querySelector('[data-testid="shell-row-open_or_send"]');
    expect(row?.textContent).toContain('Open programs, print or send');
    expect(row?.textContent).toContain(
      'start, open, xdg-open, Start-Process, lp, Out-Printer, sendmail…',
    );
    expect(pressed('open_or_send')).toBe('ask');
    expect(pressed('delete_files')).toBe('allow');
  });

  it('a click on Never for it saves that kind with that state (#667)', async () => {
    setAgentShellPolicyAction.mockImplementation(async () => ({
      ok: true,
      data: { ...DEFAULT_SHELL_POLICY, open_or_send: 'never' },
    }));
    await render(null);

    await act(async () => {
      button('open_or_send', 'never').click();
    });

    expect(setAgentShellPolicyAction.mock.calls[0]?.[0]).toEqual({
      agentId: AGENT_ID,
      category: 'open_or_send',
      state: 'never',
    });
    expect(pressed('open_or_send')).toBe('never');
  });

  it('shows what is stored', async () => {
    await render({ delete_files: 'never', download: 'ask', inline_code: 'ask' });
    expect(pressed('delete_files')).toBe('never');
    // A stored state wins over the default (#614: both default to allowed).
    expect(pressed('download')).toBe('ask');
    expect(pressed('inline_code')).toBe('ask');
  });

  it('a click saves that kind of action with that state, and the row says it', async () => {
    setAgentShellPolicyAction.mockImplementation(async () => ({
      ok: true,
      data: { ...DEFAULT_SHELL_POLICY, inline_code: 'never' },
    }));
    await render(null);

    await act(async () => {
      button('inline_code', 'never').click();
    });

    expect(setAgentShellPolicyAction.mock.calls.map((c) => c[0])).toEqual([
      { agentId: AGENT_ID, category: 'inline_code', state: 'never' },
    ]);
    expect(pressed('inline_code')).toBe('never');
  });

  it('a refused save puts the row back and says why', async () => {
    setAgentShellPolicyAction.mockImplementation(async () => ({
      ok: false,
      code: 'forbidden',
      message: 'Only the workspace owner can change what an agent may do with a shell.',
    }));
    await render(null);

    await act(async () => {
      button('delete_files', 'allow').click();
    });

    expect(pressed('delete_files')).toBe('ask');
    expect(toastError.mock.calls.map((c) => c[0])).toEqual([
      'Only the workspace owner can change what an agent may do with a shell.',
    ]);
  });

  it('a non-owner reads the rows and cannot change them', async () => {
    await render(null, false);
    expect(button('inline_code', 'never').disabled).toBe(true);
    expect(container.textContent).toContain(
      'Only the workspace owner can change what an agent may do with a shell.',
    );
  });

  it('a stored value the engine cannot read is said, not shown as defaults', async () => {
    await render({ delete_files: 'maybe' });
    expect(container.querySelector('[data-testid="shell-checklist-unreadable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="shell-row-delete_files"]')).toBeNull();
  });
});

describe('runCommandsTruth: what really happens to a command (#464, #917) @cap:regler-autonomie/ecran', () => {
  // Since #917 the sentence reads the agent's run_command ROW, the one the
  // gate applies. The workspace level is not an input: it only gave the row
  // its first value.
  it('says what each row does', () => {
    expect(runCommandsTruth({ rule: 'block', paused: false })).toBe(
      'This agent cannot run commands.',
    );
    expect(runCommandsTruth({ rule: 'require_approval', paused: false })).toBe(
      'Every command asks for your approval.',
    );
    expect(runCommandsTruth({ rule: 'auto_approve', paused: false })).toBe(
      'Commands run without asking, except the kinds of action below set to Ask me or Never.',
    );
  });

  it('reads the brake before Run without asking', () => {
    expect(runCommandsTruth({ rule: 'auto_approve', paused: true })).toBe(
      'Run without asking is paused by the auto-run brake: every command asks for your approval.',
    );
  });

  it('a missing row is said as refused, never filled with a default', () => {
    expect(runCommandsTruth({ rule: null, paused: false })).toBe(
      'No setting: every command is refused until you choose one.',
    );
  });
});
