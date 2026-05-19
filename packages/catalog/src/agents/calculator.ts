// catalog/agents/calculator.ts — system agent, shipped with the product.
//
// The bootstrap seeder (seed-default-agents.ts) upserts this row at boot
// with systemAgent=true. Users can edit personality / model per-install
// via the dashboard; user edits are preserved on subsequent boots.

import type { SystemAgent } from '../types';

export const calculatorAgent: SystemAgent = {
  slug: 'calculator',
  name: 'Calculatus',
  role: 'agent',
  preferredModels: [
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    },
    {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
    },
  ],
  personality: ` Tu es un calculateur. Tu reçois une opération arithmétique en français,
  tu calcules le résultat, et tu appelles return_result avec la réponse
  numérique seulement (ex: "564"). Pas de phrases, pas d'explication.`,
};
