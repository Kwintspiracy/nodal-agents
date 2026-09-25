// run-budget-copy.ts — la phrase du budget de run (issue #442).
//
// Dans son propre module, sans 'use client' : la section l'affiche, et la
// ligne de la liste des réglages (rendue côté serveur) la résume. Une fonction
// exportée d'un module client n'est pas appelable côté serveur.

/** Ce que les deux plafonds veulent dire, ensemble, en une phrase. */
export function runBudgetSentence(costUsd: number, hours: number): string {
  const cost = costUsd > 0 ? `once it has cost $${costUsd.toFixed(2)}` : null;
  const time = hours > 0 ? `after ${hours} h of work` : null;
  if (!cost && !time) return 'No ceiling: a run goes on until it finishes or hits another limit.';
  return `A run stops ${[cost, time].filter(Boolean).join(' or ')}. It keeps what it wrote, and says why it stopped.`;
}

/** La valeur courte de la ligne dans la liste des réglages. */
export function runBudgetValue(costUsd: number, hours: number): string {
  const cost = costUsd > 0 ? `$${costUsd.toFixed(2)} per run` : 'No cost ceiling';
  const time = hours > 0 ? `${hours} h of work` : 'no time limit';
  return `${cost}, ${time}`;
}
