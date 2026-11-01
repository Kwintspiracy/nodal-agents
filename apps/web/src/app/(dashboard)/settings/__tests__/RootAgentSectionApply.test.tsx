// RootAgentSectionApply.test.tsx — the workspace autonomy level is a template,
// and "Apply to all agents" is the one gesture that rewrites existing rows (#917).
//
// What the screen promises, on the rendered DOM and on what is SENT: the level
// says what a new agent or tool starts with; applying it to every agent asks
// first (a <ConfirmDialog />, never a native dialog) and only then calls the
// action; a level not saved yet cannot be applied behind the owner's back.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';

const actions = vi.hoisted(() => ({
  setRootAgentAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
  applyAutonomyLevelToAllAction: vi.fn(async () => ({
    ok: true as const,
    data: { changed: 3 },
  })),
}));

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const { default: RootAgentSection } = await import('../RootAgentSection.tsx');

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <RootAgentSection
        agents={[{ id: 'root-1', name: 'Alfred', role: 'orchestrator' } as never]}
        initialRootAgentId="root-1"
        initialGrants={{ ...DEFAULT_ROOT_GRANTS, autonomy: 'destructive_gate' }}
      />,
    );
  });
}

function applyButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    '[data-testid="autonomy-apply-to-all-button"]',
  );
  if (!el) throw new Error('no Apply to all button');
  return el;
}

beforeEach(() => {
  actions.applyAutonomyLevelToAllAction.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('the autonomy level is a template, applied to all only on request @cap:regler-autonomie/ecran', () => {
  it('says what the level does now: what a new agent or tool starts with', async () => {
    await render();
    expect(container.textContent).toContain(
      'The level sets what a new agent or tool starts with. Existing agents keep their settings until you apply it to them.',
    );
  });

  it('"Apply to all agents" asks first, and writes nothing before the answer', async () => {
    await render();
    await act(async () => {
      applyButton().click();
    });
    expect(document.body.textContent).toContain('Apply this level to all agents?');
    expect(document.body.textContent).toContain(
      "Every agent's tool settings, and its shared file setting, are set from Autonomous, gate destructive. Server settings and rules for all agents are removed. Rules limited to one folder are kept.",
    );
    expect(actions.applyAutonomyLevelToAllAction.mock.calls).toEqual([]);

    await act(async () => {
      [...document.body.querySelectorAll('[role="dialog"] button')]
        .find((b) => b.textContent === 'Apply to all agents')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(actions.applyAutonomyLevelToAllAction.mock.calls).toEqual([[]]);
  });

  it('cancelling applies nothing', async () => {
    await render();
    await act(async () => {
      applyButton().click();
    });
    await act(async () => {
      [...document.body.querySelectorAll('[role="dialog"] button')]
        .find((b) => b.textContent === 'Cancel')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(actions.applyAutonomyLevelToAllAction.mock.calls).toEqual([]);
  });

  it('a level chosen but not saved cannot be applied: save it first', async () => {
    await render();
    const fully = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) =>
      el.textContent?.startsWith('Fully autonomous'),
    );
    if (!fully) throw new Error('no Fully autonomous option');
    await act(async () => {
      fully.click();
    });
    expect(applyButton().disabled).toBe(true);
    expect(container.textContent).toContain('Save the level first.');
  });
});
