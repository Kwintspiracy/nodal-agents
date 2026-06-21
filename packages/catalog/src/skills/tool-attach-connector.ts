// catalog/skills/tool-attach-connector.ts — usage guide for attach_connector.
// Loaded on demand via skill_view('tool-attach-connector'). Seeded, never auto-assigned.

import type { SystemSkill } from '../types';

export const toolAttachConnectorSkill: SystemSkill = {
  slug: 'tool-attach-connector',
  name: 'Using attach_connector',
  description:
    'How to make a connector usable by an agent (the link create_connector does not make).',
  requiredBuiltins: [],
  content: `## Using attach_connector

Creating a connector is NOT enough — its operations reach an agent only once the connector is **attached** to that agent. \`attach_connector\` creates that link.

### Fields
- **connectorSlug**: the existing connector (e.g. "notion").
- **agentSlug**: the agent that should get the connector's operations.

### When to use
- After \`create_connector\` when you did NOT pass \`attachToAgentSlug\`.
- To give an existing connector to an additional agent.

### The usual flow (one agent gets a new connector)
Prefer one call: \`create_connector\` with \`attachToAgentSlug: "<agent>"\`. Use \`attach_connector\` when the connector already exists or a second agent needs it.

### Worked example
\`\`\`json
{ "connectorSlug": "notion", "agentSlug": "researcher" }
\`\`\`

### Common mistakes
- ❌ create_connector then delegate, expecting the tools to be there → ✅ attach first (or use attachToAgentSlug).
- ❌ OAuth connectors (Gmail, Drive) can't be created by an agent — those are dashboard-only; you can still attach_connector an existing one.
`,
};
