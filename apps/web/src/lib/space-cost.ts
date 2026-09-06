// space-cost.ts — ce qu'un travail a coûté (P4, plan « De la maquette au
// produit »), agrégé depuis des lignes réelles : les appels LLM du job et de
// ses délégués (par agent), les approbations tranchées (attente humaine), les
// commandes de preuve (temps de preuve). Pur, pas de DB.
//
// Un coût inconnu reste `null` — jamais un 0 qui voudrait dire « gratuit » —
// et le nombre d'appels sans prix est compté, pour que l'écran dise « partial ».

import type { SpaceCostView } from './actions.ts';

export type CostCallRow = {
  agentId: string | null;
  agentName: string | null;
  modelEffective: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
};

export type ApprovalRow = { requestedAt: Date | null; resolvedAt: Date | null };

export function aggregateSpaceCost(input: {
  calls: readonly CostCallRow[];
  approvals: readonly ApprovalRow[];
  proofMs: number;
  startedAt: Date | null;
  endedAt: Date | null;
}): SpaceCostView {
  const byKey = new Map<string, SpaceCostView['byAgent'][number] & { modelSet: Set<string> }>();
  const totals: SpaceCostView['totals'] = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    unpricedCalls: 0,
    llmDurationMs: 0,
    durationMs: 0,
    humanWaitMs: 0,
    proofMs: Math.max(0, input.proofMs),
  };

  for (const c of input.calls) {
    const key = c.agentId ?? `?:${c.agentName ?? 'unknown'}`;
    let a = byKey.get(key);
    if (!a) {
      a = {
        agentId: c.agentId,
        agentName: c.agentName ?? 'Unknown agent',
        models: [],
        modelSet: new Set<string>(),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        unpricedCalls: 0,
      };
      byKey.set(key, a);
    }
    a.calls += 1;
    a.modelSet.add(c.modelEffective);
    a.inputTokens += c.inputTokens ?? 0;
    a.outputTokens += c.outputTokens ?? 0;
    a.cachedTokens += c.cachedTokens ?? 0;
    a.cacheCreationTokens += c.cacheCreationTokens ?? 0;
    if (c.costUsd === null) a.unpricedCalls += 1;
    else a.costUsd = (a.costUsd ?? 0) + c.costUsd;

    totals.calls += 1;
    totals.inputTokens += c.inputTokens ?? 0;
    totals.outputTokens += c.outputTokens ?? 0;
    totals.cachedTokens += c.cachedTokens ?? 0;
    totals.cacheCreationTokens += c.cacheCreationTokens ?? 0;
    if (c.costUsd === null) totals.unpricedCalls += 1;
    else totals.costUsd = (totals.costUsd ?? 0) + c.costUsd;
    totals.llmDurationMs += c.durationMs ?? 0;
  }

  for (const ap of input.approvals) {
    if (ap.requestedAt && ap.resolvedAt) {
      totals.humanWaitMs += Math.max(0, ap.resolvedAt.getTime() - ap.requestedAt.getTime());
    }
  }

  if (input.startedAt) {
    const end = input.endedAt ?? new Date();
    totals.durationMs = Math.max(0, end.getTime() - input.startedAt.getTime());
  }

  const byAgent = [...byKey.values()]
    .map(({ modelSet, ...a }) => ({ ...a, models: [...modelSet] }))
    .sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0) || y.calls - x.calls);

  return { byAgent, totals };
}
