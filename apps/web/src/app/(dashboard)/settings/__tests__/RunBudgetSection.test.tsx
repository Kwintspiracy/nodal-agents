// RunBudgetSection.test.tsx — le budget de run de l'espace, à l'écran (#442).
//
// Ce que ça prouve, sur le DOM rendu et sur CE QUI PART au serveur :
//   - la phrase dit ce que les plafonds ENREGISTRÉS font, zéro compris ;
//   - Save envoie les deux nombres tapés, et la phrase suit une fois enregistré ;
//   - une valeur hors des bornes de la base est dite sous le champ, et rien ne part ;
//   - un tiers voit les champs, sans pouvoir les changer.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const actions = vi.hoisted(() => ({
  setRunBudgetAction: vi.fn(
    async (_raw: {
      maxRunCostUsd: number;
      maxRunHours: number;
    }): Promise<{ ok: true; data: undefined } | { ok: false; code: string; message: string }> => ({
      ok: true,
      data: undefined,
    }),
  ),
}));

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: RunBudgetSection } = await import('../RunBudgetSection.tsx');

let container: HTMLDivElement;
let root: Root;

async function render(initial: { maxRunCostUsd: number; maxRunHours: number; isOwner: boolean }) {
  actions.setRunBudgetAction.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RunBudgetSection initial={initial} />);
  });
}

function input(testId: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
}

async function type(testId: string, value: string) {
  const el = input(testId);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function sentence(): string {
  return container.querySelector('[data-testid="run-budget-sentence"]')!.textContent ?? '';
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Run budget, à l’écran @cap:suivre-execution/ecran', () => {
  it('dit ce que font les plafonds enregistrés, et « aucun » pour zéro', async () => {
    await render({ maxRunCostUsd: 2, maxRunHours: 0, isOwner: true });
    expect(sentence()).toBe(
      'A run stops once it has cost $2.00. It keeps what it wrote, and says why it stopped.',
    );
    act(() => root.unmount());
    container.remove();

    await render({ maxRunCostUsd: 0, maxRunHours: 0, isOwner: true });
    expect(sentence()).toBe('No ceiling: a run goes on until it finishes or hits another limit.');
  });

  it('Save envoie les deux nombres tapés, et la phrase suit', async () => {
    await render({ maxRunCostUsd: 2, maxRunHours: 0, isOwner: true });
    await type('run-budget-cost', '5');
    await type('run-budget-hours', '1.5');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="run-budget-save"]')!.click();
    });
    expect(actions.setRunBudgetAction.mock.calls).toEqual([
      [{ maxRunCostUsd: 5, maxRunHours: 1.5 }],
    ]);
    expect(sentence()).toBe(
      'A run stops once it has cost $5.00 or after 1.5 h of work. It keeps what it wrote, and says why it stopped.',
    );
  });

  it('une valeur hors des bornes est dite, et rien ne part', async () => {
    await render({ maxRunCostUsd: 2, maxRunHours: 0, isOwner: true });
    await type('run-budget-hours', '80');
    expect(container.textContent).toContain('Enter a number from 0 to 72.');
    const save = container.querySelector<HTMLButtonElement>('[data-testid="run-budget-save"]')!;
    expect(save.disabled).toBe(true);
    await act(async () => save.click());
    expect(actions.setRunBudgetAction.mock.calls).toEqual([]);
  });

  it('un tiers voit les plafonds sans pouvoir les changer', async () => {
    await render({ maxRunCostUsd: 2, maxRunHours: 4, isOwner: false });
    expect(input('run-budget-cost').disabled).toBe(true);
    expect(input('run-budget-hours').disabled).toBe(true);
    expect(container.textContent).toContain('Only the workspace owner can change this setting.');
  });
});
