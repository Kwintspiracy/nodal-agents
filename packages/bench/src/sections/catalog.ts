// catalog — the model catalogue's own integrity, offline.
//
// Adding a model is the most frequent change this repo takes, and the one with
// the least feedback: a wrong id fails at the first live call, a missing
// context window silently falls back to 128k and truncates a job, a missing
// price makes the cost cap lie. None of that shows up in a unit test, because
// there is nothing to assert against — only against the PREVIOUS catalogue.

import { MODEL_CATALOG, DEFAULT_CONTEXT_WINDOW } from '@nodal-agents/shared';
import type { Metric, Section } from '../types';

export const catalogSection: Section = {
  id: 'catalog',
  label: 'Catalogue de modèles — intégrité',
  why: 'Un contexte manquant tronque un job en silence ; un prix manquant fait mentir le plafond de coût.',
  tests: ['@nodal-agents/shared:src/tests/model-catalog.test.ts'],

  async run(): Promise<Metric[]> {
    const providers = Object.keys(MODEL_CATALOG).sort();
    let total = 0;
    let withTools = 0;
    let reasoning = 0;
    const noContext: string[] = [];
    const noPricing: string[] = [];
    const duplicates: string[] = [];
    const defaultCtx: string[] = [];

    for (const provider of providers) {
      const seen = new Set<string>();
      for (const e of MODEL_CATALOG[provider] ?? []) {
        total++;
        if (seen.has(e.modelId)) duplicates.push(`${provider}/${e.modelId}`);
        seen.add(e.modelId);
        if (e.capabilities?.tools) withTools++;
        if (e.capabilities?.reasoning) reasoning++;
        if (!e.contextWindow) noContext.push(`${provider}/${e.modelId}`);
        // A model sitting on the fallback is not necessarily wrong, but it is
        // always worth knowing: it means nobody looked the number up.
        else if (e.contextWindow === DEFAULT_CONTEXT_WINDOW)
          defaultCtx.push(`${provider}/${e.modelId}`);
        if (!e.pricing) noPricing.push(`${provider}/${e.modelId}`);
      }
    }

    return [
      {
        id: 'providers',
        label: 'Fournisseurs au catalogue',
        value: providers.length,
        unit: 'fournisseurs',
        direction: 'higher-is-better',
      },
      {
        id: 'models',
        label: 'Modèles au catalogue',
        value: total,
        unit: 'modèles',
        direction: 'higher-is-better',
      },
      {
        id: 'models_with_tools',
        label: 'Modèles déclarant les outils',
        value: withTools,
        unit: 'modèles',
        direction: 'higher-is-better',
      },
      {
        id: 'models_reasoning',
        label: 'Modèles à raisonnement',
        value: reasoning,
        unit: 'modèles',
        direction: 'higher-is-better',
      },
      {
        id: 'missing_context_window',
        label: 'Sans fenêtre de contexte',
        value: noContext.length,
        unit: 'modèles',
        direction: 'lower-is-better',
        detail: noContext,
      },
      {
        id: 'missing_pricing',
        label: 'Sans tarif',
        value: noPricing.length,
        unit: 'modèles',
        direction: 'lower-is-better',
        detail: noPricing,
      },
      {
        id: 'duplicate_ids',
        label: 'Identifiants dupliqués chez un fournisseur',
        value: duplicates.length,
        unit: 'doublons',
        direction: 'lower-is-better',
        detail: duplicates,
      },
      {
        id: 'context_on_fallback',
        label: 'Contexte laissé sur la valeur par défaut',
        value: defaultCtx.length,
        unit: 'modèles',
        direction: 'lower-is-better',
        detail: defaultCtx,
      },
    ];
  },
};
