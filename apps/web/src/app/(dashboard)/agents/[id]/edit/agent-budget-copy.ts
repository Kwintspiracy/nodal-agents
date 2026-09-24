// agent-budget-copy.ts — ce que la section Budget d'un agent dit de son état
// (issue #447). Pure, dans son propre module : la section l'affiche, et le
// test la prouve sans monter l'écran.

export interface BudgetStatusInput {
  dailyUsd: number;
  monthlyUsd: number;
  alertPct: number;
  todayUsd: number;
  monthUsd: number;
  reached: 'day' | 'month' | null;
}

/**
 * La ligne d'état : atteint (rouge, les runs s'arrêtent jusqu'à la fin de la
 * fenêtre), proche (orange, à partir du seuil d'alerte), ou rien.
 */
export function budgetStatus(v: BudgetStatusInput): { tone: 'err' | 'warn'; text: string } | null {
  if (v.reached === 'day') {
    return {
      tone: 'err',
      text: `Daily ceiling reached: this agent's runs stop until midnight. They keep what they wrote.`,
    };
  }
  if (v.reached === 'month') {
    return {
      tone: 'err',
      text: `Monthly ceiling reached: this agent's runs stop until the 1st. They keep what they wrote.`,
    };
  }
  const share = (spent: number, ceiling: number) => (ceiling > 0 ? (spent / ceiling) * 100 : 0);
  const day = share(v.todayUsd, v.dailyUsd);
  const month = share(v.monthUsd, v.monthlyUsd);
  if (day >= v.alertPct) {
    return { tone: 'warn', text: `${Math.floor(day)}% of the daily ceiling spent.` };
  }
  if (month >= v.alertPct) {
    return { tone: 'warn', text: `${Math.floor(month)}% of the monthly ceiling spent.` };
  }
  return null;
}
