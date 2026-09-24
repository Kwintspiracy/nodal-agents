// AgentBudgetSection.test.tsx — le budget de l'agent, à l'écran (#447).
//
// Ce que ça prouve, sur le DOM rendu et sur CE QUI PART au serveur :
//   - la dépense du jour et du mois, lue de l'action, avec les plafonds ;
//   - l'état : atteint (les runs s'arrêtent jusqu'à minuit), proche du seuil,
//     ou rien ;
//   - Save envoie les trois nombres tapés ; hors bornes, rien ne part.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { budgetStatus } from '../agent-budget-copy.ts';

type View = {
  dailyUsd: number;
  monthlyUsd: number;
  alertPct: number;
  todayUsd: number;
  monthUsd: number;
  timezone: string;
  reached: 'day' | 'month' | null;
};

const actions = vi.hoisted(() => ({
  getAgentBudgetAction: vi.fn(
    async (
      _agentId: string,
    ): Promise<{ ok: true; data: View } | { ok: false; message: string }> => ({
      ok: false,
      message: 'unset',
    }),
  ),
  setAgentBudgetAction: vi.fn(
    async (_raw: {
      agentId: string;
      dailyUsd: number;
      monthlyUsd: number;
      alertPct: number;
    }): Promise<{ ok: true; data: undefined } | { ok: false; code: string; message: string }> => ({
      ok: true,
      data: undefined,
    }),
  ),
}));

vi.mock('@/lib/actions.ts', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: AgentBudgetSection } = await import('../AgentBudgetSection.tsx');

const AGENT_ID = '66666666-6666-4666-8666-666666666666';
let container: HTMLDivElement;
let root: Root;

const VIEW: View = {
  dailyUsd: 10,
  monthlyUsd: 0,
  alertPct: 80,
  todayUsd: 8.5,
  monthUsd: 42.25,
  timezone: 'Europe/Paris',
  reached: null,
};

async function render(view: View) {
  actions.getAgentBudgetAction.mockImplementation(async () => ({ ok: true, data: view }));
  actions.setAgentBudgetAction.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AgentBudgetSection agentId={AGENT_ID} canChange />);
  });
  await act(async () => {});
  await act(async () => {});
}

async function type(testId: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function text(testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Agent budget, à l’écran @cap:voir-le-cout/ecran', () => {
  it('montre la dépense du jour et du mois, avec les plafonds posés', async () => {
    await render(VIEW);
    expect(text('agent-budget-spend')).toContain('Spent today$8.50 of $10.00');
    // Pas de plafond du mois : la dépense seule.
    expect(text('agent-budget-spend')).toContain('Spent this month$42.25');
    expect(text('agent-budget-spend')).not.toContain('of $0.00');
    // 85 % du jour ≥ 80 % : l'écran prévient.
    expect(text('agent-budget-status')).toBe('85% of the daily ceiling spent.');
    expect(container.textContent).toContain('workspace time zone (Europe/Paris)');
  });

  it('dit la pause quand un plafond est atteint', async () => {
    await render({ ...VIEW, todayUsd: 10.2, reached: 'day' });
    expect(text('agent-budget-status')).toBe(
      "Daily ceiling reached: this agent's runs stop until midnight. They keep what they wrote.",
    );
  });

  it('Save envoie les trois nombres ; hors bornes, rien ne part', async () => {
    await render(VIEW);
    await type('agent-budget-monthly', '200');
    await type('agent-budget-alert', '90');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-budget-save"]')!.click();
    });
    expect(actions.setAgentBudgetAction.mock.calls).toEqual([
      [{ agentId: AGENT_ID, dailyUsd: 10, monthlyUsd: 200, alertPct: 90 }],
    ]);

    await type('agent-budget-daily', '5000');
    expect(container.textContent).toContain('Enter a number from 0 to 1000.');
    const save = container.querySelector<HTMLButtonElement>('[data-testid="agent-budget-save"]')!;
    expect(save.disabled).toBe(true);
  });
});

describe('budgetStatus @cap:voir-le-cout/ecran', () => {
  const base = { dailyUsd: 10, monthlyUsd: 100, alertPct: 80, todayUsd: 0, monthUsd: 0 };
  it('rien sous le seuil, et rien sans plafond', () => {
    expect(budgetStatus({ ...base, todayUsd: 7.9, reached: null })).toBeNull();
    expect(
      budgetStatus({
        ...base,
        dailyUsd: 0,
        monthlyUsd: 0,
        todayUsd: 999,
        monthUsd: 999,
        reached: null,
      }),
    ).toBeNull();
  });
  it('le mois atteint dit le 1er', () => {
    expect(budgetStatus({ ...base, monthUsd: 100, reached: 'month' })?.text).toBe(
      "Monthly ceiling reached: this agent's runs stop until the 1st. They keep what they wrote.",
    );
  });
  it('le seuil du mois prévient quand le jour ne le fait pas', () => {
    expect(budgetStatus({ ...base, todayUsd: 1, monthUsd: 90, reached: null })).toEqual({
      tone: 'warn',
      text: '90% of the monthly ceiling spent.',
    });
  });
});
