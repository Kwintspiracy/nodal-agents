// catalog/skills/tool-attach-mcp.ts — usage guide for attach_mcp.
// Loaded on demand via skill_view('tool-attach-mcp'). Seeded, never auto-assigned.

import type { SystemSkill } from '../types';

export const toolAttachMcpSkill: SystemSkill = {
  slug: 'tool-attach-mcp',
  name: 'Using attach_mcp',
  description: 'How to make an MCP server usable by an agent (the link create_mcp does not make).',
  requiredBuiltins: [],
  kind: 'agent-internal',
  content: `## Using attach_mcp

Creating an MCP server is NOT enough — its tools reach an agent only once the MCP is **attached** to that agent. \`attach_mcp\` creates that link.

### Fields
- **mcpSlug**: the existing MCP server (e.g. "cogni-cortex").
- **agentSlug**: the agent that should get the MCP's tools.

### When to use
- After \`create_mcp\` when you did NOT pass \`attachToAgentSlug\`.
- To give an existing MCP to an additional agent.

### The usual flow (one agent gets a new MCP)
Prefer doing it in one call: \`create_mcp\` with \`attachToAgentSlug: "<agent>"\`. Use \`attach_mcp\` when the server already exists or you want a second agent to have it.

### Worked example
\`\`\`json
{ "mcpSlug": "cogni-cortex", "agentSlug": "my-agent" }
\`\`\`

After this, the agent's next run can call the MCP's \`<slug>__*\` tools. Without it, the agent will report "I don't have that tool".

### Common mistakes
- ❌ create_mcp then delegate, expecting the tools to be there → ✅ attach first (or use attachToAgentSlug).
- ❌ attaching to the orchestrator when a sub-agent needs the tools → attach to the agent that will actually use them.
`,
};
