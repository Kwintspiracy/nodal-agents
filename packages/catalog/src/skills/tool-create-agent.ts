// catalog/skills/tool-create-agent.ts — usage guide for the create_agent meta-tool.
//
// Loaded ON DEMAND via skill_view('tool-create-agent') right before the agent
// calls create_agent — NOT auto-injected. Seeded into agent_skills so skill_view
// can read it, but never auto-assigned.

import type { SystemSkill } from '../types';

export const toolCreateAgentSkill: SystemSkill = {
  slug: 'tool-create-agent',
  name: 'Using create_agent',
  description:
    'How to format a create_agent call + the create-before-attach sequence and id rules.',
  requiredBuiltins: [],
  kind: 'agent-internal',
  content: `## Using create_agent

Create a new agent (a worker, or a sub-orchestrator) in your workspace, assigned under you.

### Fields
- **name**: human-readable name (e.g. "Java").
- **slug**: lowercase-with-hyphens, unique in the workspace.
- **personality**: the agent's system prompt / identity — who it is and how it works.
- **model**: the model id it runs on — never guess it, see "Picking a model" below.
- **role**: \`"worker"\` (does tasks) | \`"router"\` | \`"planner"\` (orchestrate others).
- **subAgentSlugs**: only for router/planner — existing agents to place under it.

### Picking a model — never guess the id
A model is a precise id, not free text. When the user names a model ("DeepSeek v4 pro", "Sonnet"):
1. Call **\`list_models\`** → it returns the valid ids + labels for the provider.
2. Pick the entry whose label matches what the user asked, and pass its exact **id**.

Example: "run it on DeepSeek v4 pro" → list_models shows \`deepseek/deepseek-v4-pro\` (label "DeepSeek V4 Pro") → pass that exact id. A model id that isn't valid for the provider (e.g. \`deepseek-chat\` on an OpenRouter key) is rejected.

### Sequence: create BEFORE you attach or delegate
An agent must EXIST before you can attach to it or hand it work. If a task names an agent (or gives an id) that isn't in the workspace yet, **create it first**:
1. \`create_agent\` → you get its real id in the result.
2. THEN \`attach_agent\` / delegate to it, using that real id.

Calling \`attach_agent\` on an agent that doesn't exist fails with \`No agent named "..."\`. If you see that, the agent isn't there — create it, don't retry the attach.

### The id rule
NEVER invent an id, and don't pass an id where a name is expected. A UUID copied from a task prompt may be stale or wrong — trust only the id returned by \`create_agent\`.

### Worked example
\`\`\`json
{
  "name": "Java",
  "slug": "java",
  "role": "worker",
  "model": "anthropic/claude-sonnet-4.6",
  "personality": "You are Java, a focused research worker. You read carefully, cite sources, and return tight, well-formatted results."
}
\`\`\`

### Common mistakes
- ❌ attach/delegate before create → ✅ create first, then attach using the returned id.
- ❌ inventing or reusing a stale id → ✅ use the id \`create_agent\` returns.
- ❌ reusing a slug already in the workspace → choose a unique one.
`,
};
