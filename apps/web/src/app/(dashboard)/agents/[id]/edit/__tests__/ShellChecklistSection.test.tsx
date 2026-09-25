// ShellChecklistSection.test.tsx — what an agent may NOT do with a shell (#464).
//
// What this proves, rendered in jsdom and CLICKED: an agent nobody configured
// shows "Ask me" on every row; a click sends the action the kind of action and
// the state the owner chose (the ARGUMENT, invariant #5), and the row shows
// it; a refused save puts the row back; a non-owner sees the rows and cannot
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
  it('an agent nobody configured asks for every kind of action', async () => {
    await render(null);
    expect(SHELL_CATEGORIES.map(pressed)).toEqual(SHELL_CATEGORIES.map(() => 'ask'));
    expect(container.textContent).toContain('Run code written into a command');
    expect(container.textContent).toContain('Delete files or discard changes');
    expect(container.textContent).not.toContain('outside its folders');
  });

  it('says what a reading can promise: a script run from a file is not read (review of PR #474)', async () => {
    await render(null);
    // A reading of the command is not a sandbox, and the screen does not
    // pretend the agent stays in its folders.
    expect(container.textContent).toContain(
      'Nodal reads each command, then runs it, asks you first, or refuses it, at every autonomy level. A script run from a file is not read: it can do any of these unseen.',
    );
  });

  it('shows what is stored', async () => {
    await render({ delete_files: 'never', download: 'allow' });
    expect(pressed('delete_files')).toBe('never');
    expect(pressed('download')).toBe('allow');
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

describe('runCommandsTruth: what really happens to a command (#464) @cap:regler-autonomie/ecran', () => {
  it('says the truth under destructive_gate, where no rule means ordinary commands run', () => {
    expect(runCommandsTruth({ rule: null, paused: false, autonomy: 'destructive_gate' })).toBe(
      'Ordinary commands run without asking: the workspace only gates risky actions. The kinds of action below follow their setting.',
    );
  });

  it('says full autonomy does not cover the shell', () => {
    expect(runCommandsTruth({ rule: null, paused: false, autonomy: 'fully_autonomous' })).toBe(
      'Every command asks for your approval. Full autonomy never covers the shell: only Run without asking does.',
    );
  });

  it('reads the rule before the level, and the brake before Run without asking', () => {
    expect(runCommandsTruth({ rule: 'block', paused: false, autonomy: 'destructive_gate' })).toBe(
      'This agent cannot run commands: a rule blocks them.',
    );
    expect(
      runCommandsTruth({ rule: 'auto_approve', paused: true, autonomy: 'propose_confirm' }),
    ).toBe(
      'Run without asking is paused by the auto-run brake: every command asks for your approval.',
    );
    expect(
      runCommandsTruth({ rule: 'auto_approve', paused: false, autonomy: 'propose_confirm' }),
    ).toBe('Commands run without asking, except the kinds of action below set to Ask me or Never.');
    expect(runCommandsTruth({ rule: null, paused: false, autonomy: 'propose_confirm' })).toBe(
      'Every command asks for your approval.',
    );
    expect(runCommandsTruth({ rule: null, paused: false, autonomy: null })).toBe(
      'How commands run depends on the workspace autonomy.',
    );
  });
  // Review of PR #481 (Reviewer A, P2): a rule confined to a folder only holds
  // there, and the sentence said "run without asking" everywhere.
  it('names the folder of a confined rule, and says the workspace decides elsewhere', () => {
    const base = { paused: false, autonomy: 'propose_confirm' as const, folder: 'Dev' };
    expect(runCommandsTruth({ ...base, rule: 'auto_approve' })).toBe(
      'In Dev, commands run without asking, except the kinds of action below set to Ask me or Never. Elsewhere, the workspace autonomy decides.',
    );
    expect(runCommandsTruth({ ...base, rule: 'block' })).toBe(
      'In Dev, a rule blocks commands. Elsewhere, the workspace autonomy decides.',
    );
    expect(runCommandsTruth({ ...base, rule: 'require_approval' })).toBe(
      'In Dev, every command asks for your approval. Elsewhere, the workspace autonomy decides.',
    );
  });
});
