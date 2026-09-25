// FirstTokenWaitField.test.tsx — l'attente du premier mot, par agent (#442).
//
// Ce que ça prouve, sur le DOM rendu et sur CE QUI PART au serveur :
//   - vide, la ligne dit que la plateforme décide ; Save n'est pas offert ;
//   - un nombre de secondes part tel quel, un champ vidé part en `null` ;
//   - une valeur hors des bornes de la base est dite, et rien ne part.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const actions = vi.hoisted(() => ({
  setAgentFirstTokenWaitAction: vi.fn(
    async (_raw: {
      agentId: string;
      seconds: number | null;
    }): Promise<{ ok: true; data: undefined } | { ok: false; code: string; message: string }> => ({
      ok: true,
      data: undefined,
    }),
  ),
}));

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: FirstTokenWaitField } = await import('../FirstTokenWaitField.tsx');

const AGENT_ID = '55555555-5555-4555-8555-555555555555';
let container: HTMLDivElement;
let root: Root;

async function render(initialSeconds: number | null) {
  actions.setAgentFirstTokenWaitAction.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <FirstTokenWaitField agentId={AGENT_ID} initialSeconds={initialSeconds} canChange />,
    );
  });
}

async function type(value: string) {
  const el = container.querySelector<HTMLInputElement>('[data-testid="first-token-wait-input"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function save(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="first-token-wait-save"]')!;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Wait for the first word @cap:suivre-execution/ecran', () => {
  it('vide : la plateforme décide, et rien à enregistrer', async () => {
    await render(null);
    expect(container.textContent).toContain(
      'Empty: 2 minutes, raised for a long context or a high reasoning effort.',
    );
    expect(save().disabled).toBe(true);
  });

  it('des secondes partent telles quelles ; un champ vidé part en null', async () => {
    await render(null);
    await type('600');
    await act(async () => save().click());
    expect(actions.setAgentFirstTokenWaitAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      seconds: 600,
    });
    expect(container.textContent).toContain('Set for this agent: 600 s');

    await type('');
    await act(async () => save().click());
    expect(actions.setAgentFirstTokenWaitAction.mock.calls.at(-1)?.[0]).toEqual({
      agentId: AGENT_ID,
      seconds: null,
    });
  });

  it('hors des bornes : dit, et rien ne part', async () => {
    await render(null);
    await type('10');
    expect(container.textContent).toContain(
      'Enter whole seconds from 30 to 3600, or leave it empty.',
    );
    expect(save().disabled).toBe(true);
    await act(async () => save().click());
    expect(actions.setAgentFirstTokenWaitAction.mock.calls).toEqual([]);
  });
});
