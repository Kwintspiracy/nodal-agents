// TeamChangeSection.test.tsx — the screen of `agents.may_change_team` (#137).
//
// What this proves: the switch renders the saved value, sends the value the
// owner chose to `setAgentMayChangeTeamAction`, and goes back to where it was
// when the action refuses — which is what a non-owner gets. The assertions are
// on the ARGUMENT the mocked action receives and on the text the owner reads
// (invariant #5), never on a call count.
//
// The engine level of the same capability — the three tools actually leaving a
// real run's tool list — is proved by
// `apps/runner/src/tests/job/may-change-team.test.ts`. A green screen here
// says the button exists and saves, and nothing about what the runner does.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import TeamChangeSection from '../TeamChangeSection.tsx';

type SaveResult = { ok: true } | { ok: false; code: string; message: string };
type SaveInput = { agentId: string; mayChangeTeam: boolean };

const setAgentMayChangeTeamAction = vi.hoisted(() =>
  vi.fn(async (_raw: SaveInput): Promise<SaveResult> => ({ ok: true })),
);

vi.mock('@/lib/actions.ts', () => ({ setAgentMayChangeTeamAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = '22222222-2222-4222-8222-222222222222';

let container: HTMLDivElement;
let root: Root;

async function render(mayChangeTeam: boolean, isOwner = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <TeamChangeSection agentId={AGENT_ID} mayChangeTeam={mayChangeTeam} isOwner={isOwner} />,
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
  const calls = setAgentMayChangeTeamAction.mock.calls;
  if (calls.length === 0) throw new Error('the action was never called');
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  setAgentMayChangeTeamAction.mockClear();
  setAgentMayChangeTeamAction.mockImplementation(async () => ({ ok: true as const }));
});

describe('TeamChangeSection — what the owner saves @cap:assigner-outils/ecran', () => {
  it('renders the saved value: off stays off until someone turns it on', async () => {
    await render(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(
      'Off: this agent works with the team you gave it, and says so when it needs someone else',
    );
  });

  it('renders an agent whose owner already turned it on', async () => {
    await render(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain(
      'On: this agent can create agents, attach them to itself and detach them while it works',
    );
  });

  it('turning it on sends mayChangeTeam: true for this agent', async () => {
    await render(false);
    await click();
    expect(lastArgument()).toEqual({ agentId: AGENT_ID, mayChangeTeam: true });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('turning it back off sends mayChangeTeam: false', async () => {
    await render(true);
    await click();
    expect(lastArgument()).toEqual({ agentId: AGENT_ID, mayChangeTeam: false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('a refused save shows the reason and leaves the switch where it was', async () => {
    // What a non-owner gets from the server action. The screen must not keep
    // showing a power the database did not grant.
    setAgentMayChangeTeamAction.mockImplementation(async () => ({
      ok: false as const,
      code: 'forbidden',
      message: 'Only the workspace owner can change who an agent may recruit.',
    }));
    await render(false);
    await click();

    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(
      'Only the workspace owner can change who an agent may recruit.',
    );
  });

  it('says what off actually does, so the setting is not read as a style choice', async () => {
    await render(false);
    expect(container.textContent).toContain(
      'the three tools are absent from the list the runner builds for each run',
    );
  });
});
