// SecretMaskSection.test.tsx — the screen of `agents.mask_secret_shapes` (0175).
//
// What this proves: the switch renders the saved value with the words that
// say what it does, says beside it what stays hidden whatever it says, says
// for a CLI-served agent what Nodal cannot hide, sends the value the owner
// chose to `setAgentMaskSecretShapesAction`, and goes back when the action
// refuses. Assertions on the argument the mocked action receives and on the
// text the owner reads, never on a call count.
//
// The engine level of the same setting (a shaped value passing for this agent
// and not for another, a registered value hidden for both) is proved on a
// real run in `packages/tools/src/tests/tool-result-boundary.test.ts` and on
// the stored policy in `packages/db/src/tests/tool-result-mask.test.ts`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SecretMaskSection, {
  SECRET_MASK_ALWAYS_LINE,
  SECRET_MASK_CLI_LINE,
  secretMaskStateLine,
} from '../SecretMaskSection.tsx';

type SaveResult = { ok: true } | { ok: false; code: string; message: string };
type SaveInput = { agentId: string; maskSecretShapes: boolean };

const setAgentMaskSecretShapesAction = vi.hoisted(() =>
  vi.fn(async (_raw: SaveInput): Promise<SaveResult> => ({ ok: true })),
);

vi.mock('@/lib/actions.ts', () => ({ setAgentMaskSecretShapesAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = '33333333-3333-4333-8333-333333333333';

let container: HTMLDivElement;
let root: Root;

async function render(
  maskSecretShapes: boolean | undefined,
  opts: { isCliRuntime?: boolean; canChange?: boolean } = {},
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SecretMaskSection
        agentId={AGENT_ID}
        maskSecretShapes={maskSecretShapes}
        isCliRuntime={opts.isCliRuntime ?? false}
        canChange={opts.canChange ?? true}
      />,
    );
  });
}

function toggle(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!el) throw new Error('no switch rendered');
  return el;
}

async function click(): Promise<void> {
  await act(async () => {
    toggle().click();
  });
}

function lastArgument(): SaveInput {
  const calls = setAgentMaskSecretShapesAction.mock.calls;
  if (calls.length === 0) throw new Error('the action was never called');
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  setAgentMaskSecretShapesAction.mockClear();
  setAgentMaskSecretShapesAction.mockImplementation(async () => ({ ok: true as const }));
});

describe('SecretMaskSection — what the owner reads and saves @cap:configurer-agent/ecran', () => {
  it('on: says the agent cannot read a secret value from a tool result', async () => {
    await render(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain(
      'this agent cannot read a secret value from a tool result',
    );
  });

  it('off: says shaped values pass, and the keys Nodal holds are still hidden', async () => {
    await render(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(secretMaskStateLine(false));
    expect(container.textContent).toContain(SECRET_MASK_ALWAYS_LINE);
    expect(SECRET_MASK_ALWAYS_LINE).toContain('in every case');
  });

  it('a CLI-served agent is told what Nodal cannot hide; a Nodal agent is not', async () => {
    await render(true, { isCliRuntime: true });
    expect(container.textContent).toContain(SECRET_MASK_CLI_LINE);
    await render(true, { isCliRuntime: false });
    expect(container.textContent).not.toContain(SECRET_MASK_CLI_LINE);
  });

  it('turning it off sends maskSecretShapes: false for this agent', async () => {
    await render(true);
    await click();
    expect(lastArgument()).toEqual({ agentId: AGENT_ID, maskSecretShapes: false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('a refused save shows the reason and leaves the switch where it was', async () => {
    setAgentMaskSecretShapesAction.mockImplementation(async () => ({
      ok: false as const,
      code: 'forbidden',
      message: 'Only the workspace owner can change what an agent may read.',
    }));
    await render(true);
    await click();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain(
      'Only the workspace owner can change what an agent may read.',
    );
  });

  it('a value that could not be read is said, and the switch shows no state it does not know', async () => {
    await render(undefined);
    expect(container.textContent).toContain('This setting could not be read.');
    expect(toggle().disabled).toBe(true);
  });
});
