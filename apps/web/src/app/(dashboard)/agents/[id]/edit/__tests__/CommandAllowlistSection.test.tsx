// CommandAllowlistSection.test.tsx — issue #131.
//
// What this proves: the screen sends to `setAgentCommandAllowlistAction` the
// value the owner actually chose, and the two values that look alike in a text
// field are told apart:
//
//   an emptied field            → null  (no list, unrestricted again)
//   "Refuse every command"      → []    (every command refused)
//   two lines                   → ['node', 'npx vitest']
//
// Rendered in jsdom and TYPED, not only rendered: the assertions are on the
// ARGUMENT the mocked action receives (invariant #5), never on a call count.
//
// The e2e journey (`command-allowlist.spec.ts`) plays the same three states in
// a browser against a real database; this file sees them without one, so a
// swap of null and [] is red here in a second rather than in the nightly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CommandAllowlistSection from '../CommandAllowlistSection.tsx';

type SaveResult = { ok: true } | { ok: false; code: string; message: string };
type SaveInput = { agentId: string; allowlist: string[] | null };

const setAgentCommandAllowlistAction = vi.hoisted(() =>
  vi.fn(async (_raw: SaveInput): Promise<SaveResult> => ({ ok: true })),
);

vi.mock('@/lib/actions.ts', () => ({ setAgentCommandAllowlistAction }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

let container: HTMLDivElement;
let root: Root;

async function render(allowlist: string[] | null): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <CommandAllowlistSection agentId={AGENT_ID} allowlist={allowlist} hasCommandSkill isOwner />,
    );
  });
}

function entriesField(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="command-allowlist-entries"]',
  );
  if (!el) throw new Error('no entries field rendered');
  return el;
}

function refuseEveryBox(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    '[data-testid="command-allowlist-refuse-every"]',
  );
  if (!el) throw new Error('no "refuse every command" checkbox rendered');
  return el;
}

/** Types a whole value at once, the way a paste does. */
async function typeEntries(text: string): Promise<void> {
  const el = entriesField();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function check(box: HTMLInputElement): Promise<void> {
  await act(async () => {
    box.click();
  });
}

async function save(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').trim().startsWith('Save'),
  );
  if (!button) throw new Error('no Save button rendered');
  await act(async () => {
    button.click();
  });
}

function lastArgument(): SaveInput {
  const calls = setAgentCommandAllowlistAction.mock.calls;
  if (calls.length === 0) throw new Error('the action was never called');
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  setAgentCommandAllowlistAction.mockClear();
  setAgentCommandAllowlistAction.mockImplementation(async () => ({ ok: true as const }));
});

describe('CommandAllowlistSection — what the owner saves @cap:assigner-outils/ecran', () => {
  it('two lines are saved as two entries', async () => {
    await render(null);
    await typeEntries('node\nnpx vitest');
    await save();

    expect(lastArgument()).toEqual({ agentId: AGENT_ID, allowlist: ['node', 'npx vitest'] });
  });

  it('an emptied field saves null, never an empty list', async () => {
    await render(['node']);
    await typeEntries('');
    await save();

    const arg = lastArgument() as { allowlist: string[] | null };
    expect(arg.allowlist).toBeNull();
    // The distinction this test exists for: null gives the agent back the
    // unrestricted behaviour, [] refuses everything it tries to run.
    expect(arg.allowlist).not.toEqual([]);
  });

  it('"Refuse every command" saves an empty list, never null', async () => {
    await render(null);
    await check(refuseEveryBox());
    await save();

    const arg = lastArgument() as { allowlist: string[] | null };
    expect(arg.allowlist).toEqual([]);
    expect(arg.allowlist).not.toBeNull();
  });

  it('blank lines and stray spaces are not entries', async () => {
    await render(null);
    await typeEntries('  node  \n\n   \nnpx    vitest\n');
    await save();

    expect((lastArgument() as { allowlist: string[] }).allowlist).toEqual(['node', 'npx vitest']);
  });

  it('the three states are said in words', async () => {
    await render(null);
    expect(container.textContent).toContain(
      'No list: this agent may start any command (what every agent has today)',
    );

    await typeEntries('node\nnpx vitest');
    expect(container.textContent).toContain(
      '2 entries: only these programs start, one per command, no shell',
    );

    await check(refuseEveryBox());
    expect(container.textContent).toContain('Empty list: every command is refused');
  });

  it('says what the list does not govern', async () => {
    await render(null);
    const text = container.textContent ?? '';
    expect(text).toContain('This list governs run_command only');
    expect(text).toContain('Skill scripts, Code tasks and verification commands are not affected');
  });

  it('renders the message of a refused save, next to the field', async () => {
    const REFUSED =
      'A shell cannot be on the list: it would run anything. ' +
      'Name the programs the agent needs (node, npx vitest, git) instead.';
    setAgentCommandAllowlistAction.mockImplementation(async () => ({
      ok: false as const,
      code: 'validation_failed',
      message: REFUSED,
    }));

    await render(null);
    await typeEntries('powershell');
    await save();

    const error = container.querySelector('[data-testid="command-allowlist-error"]');
    expect(error?.textContent).toBe(REFUSED);
    // A refused save leaves the saved state alone: the agent still has no list.
    expect(
      container.querySelector('[data-testid="command-allowlist-state"]')?.textContent,
    ).toContain('No list');
  });

  it('a non-owner cannot change the list, and is told why', async () => {
    // Same gate as the CLI runtime mode control: the action refuses a
    // non-owner only outside local-trust, so the screen locks there too.
    const before = process.env['NEXT_PUBLIC_AUTH_MODE'];
    process.env['NEXT_PUBLIC_AUTH_MODE'] = 'multi-user';
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(
          <CommandAllowlistSection
            agentId={AGENT_ID}
            allowlist={['node']}
            hasCommandSkill
            isOwner={false}
          />,
        );
      });

      expect(entriesField().disabled).toBe(true);
      expect(refuseEveryBox().disabled).toBe(true);
      expect(container.textContent).toContain(
        'Only the workspace owner can change what an agent is allowed to run.',
      );
      // It still READS: the list is not a secret from the rest of the workspace.
      expect(entriesField().value).toBe('node');
    } finally {
      if (before === undefined) delete process.env['NEXT_PUBLIC_AUTH_MODE'];
      else process.env['NEXT_PUBLIC_AUTH_MODE'] = before;
    }
  });
});
