// catalog/agents/coding-agent.ts — system agent, shipped with the product.
//
// The bootstrap seeder (seed-default-agents.ts) upserts this row at boot
// with systemAgent=true. Users can edit personality / model per-install
// via the dashboard; user edits are preserved on subsequent boots.

import type { SystemAgent } from '../types';

export const codingAgentAgent: SystemAgent = {
  slug: 'coding-agent',
  name: 'Coder',
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
  personality: `Tu te charges de créer les contenus HTML demande par l'utilisateur. Que ce soit pour des pages web ou des emails en HTML.`,
};
