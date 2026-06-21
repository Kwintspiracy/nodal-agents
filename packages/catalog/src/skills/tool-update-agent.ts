// catalog/skills/tool-update-agent.ts — usage guide for the update_agent meta-tool.
// Loaded ON DEMAND via skill_view('tool-update-agent'). Seeded, never auto-assigned.

import type { SystemSkill } from '../types';

export const toolUpdateAgentSkill: SystemSkill = {
  slug: 'tool-update-agent',
  name: 'Using update_agent',
  description: 'How to edit an existing agent (model, personality, name) + picking a valid model.',
  requiredBuiltins: [],
  agentInternal: true,
  content: `## Using update_agent

Edit an EXISTING agent. Use it to change an agent's model, personality, or display name — you do NOT need to recreate it.

### Fields
- **slug** (required): the existing agent to edit (e.g. "java").
- **model** (optional): a new model id — see "Picking a model" below.
- **personality** (optional): a new system prompt / identity.
- **name** (optional): a new display name.

Provide at least one of model / personality / name.

### Picking a model — never guess the id
A model is a precise id, not free text. When the user names a model ("DeepSeek v4 pro", "Sonnet"):
1. Call **\`list_models\`** → it returns the valid ids + labels for the provider.
2. Find the entry whose label matches what the user asked, and pass its exact **id**.

Example: user says "run it on DeepSeek v4 pro" → list_models shows \`deepseek/deepseek-v4-pro\` (label "DeepSeek V4 Pro") → pass \`"model": "deepseek/deepseek-v4-pro"\`.

Passing an id that isn't valid for the agent's provider (e.g. \`deepseek-chat\` on an OpenRouter key) is rejected — call list_models and use the exact id.

### Worked example
\`\`\`json
{ "slug": "java", "model": "deepseek/deepseek-v4-pro" }
\`\`\`

### Common mistakes
- ❌ guessing a model string from memory → ✅ call list_models, copy the exact id.
- ❌ trying to "recreate" the agent to change its model → ✅ update_agent edits it in place.
- ❌ wrong slug → the agent must exist (check the slug).
`,
};
