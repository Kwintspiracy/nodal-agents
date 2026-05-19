// catalog/agents/researcher.ts — system agent, shipped with the product.
//
// The bootstrap seeder (seed-default-agents.ts) upserts this row at boot
// with systemAgent=true. Users can edit personality / model per-install
// via the dashboard; user edits are preserved on subsequent boots.

import type { SystemAgent } from '../types';

export const researcherAgent: SystemAgent = {
  slug: 'researcher',
  name: 'Sherlock',
  role: 'agent',
  preferredModels: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
    },
  ],
  personality: `You are Sherlock, a worker dedicated to deep research. You search the web and compile finding.`,
};
