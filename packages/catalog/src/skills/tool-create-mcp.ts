// catalog/skills/tool-create-mcp.ts — usage guide for the create_mcp meta-tool.
//
// Loaded ON DEMAND via skill_view('tool-create-mcp') right before the agent
// calls create_mcp — NOT auto-injected (keeps the prompt lean). Seeded into
// agent_skills so skill_view can read it, but never auto-assigned.

import type { SystemSkill } from '../types';

export const toolCreateMcpSkill: SystemSkill = {
  slug: 'tool-create-mcp',
  name: 'Using create_mcp',
  description:
    'How to format a create_mcp call correctly — http/stdio, where the API key goes, examples.',
  requiredBuiltins: [],
  kind: 'agent-internal',
  content: `## Using create_mcp

Provision an MCP server so its tools become available in this workspace. The call is VERIFIED by actually connecting before anything is saved, so a wrong format fails loudly — get it right the first time.

### Fields
- **name**: human-readable label.
- **slug**: lowercase-with-hyphens, unique in the workspace. It prefixes the server's tool names.
- **transport**: \`"http"\` (remote server) or \`"stdio"\` (local subprocess).

**transport "http":**
- **url**: the endpoint, WITHOUT the key in it.
- **apiKey**: the key/token — it goes HERE, never inside the url.
- **authScheme**: how the key is sent — \`"header"\` (default), \`"query"\`, or \`"bearer"\`.
- **authParamName**: the header name or query-param name that carries the key (omit only for bearer).

**transport "stdio":** command, args, env.

### #1 mistake: the key inside the URL
If you are given a URL like \`https://host/api/mcp?api_key=cog_ABC\`, do NOT pass that whole string as \`url\`. **Split it**:
- url → \`https://host/api/mcp\`
- apiKey → \`cog_ABC\`
- authScheme → \`query\`
- authParamName → \`api_key\`

The tool re-attaches the key correctly. Passing the key inside \`url\` (with \`apiKey\` empty) fails with: \`transport "http" requires an apiKey\`.

### Worked example — key as a query param
\`\`\`json
{
  "name": "Cogni Cortex",
  "slug": "cogni-cortex",
  "transport": "http",
  "url": "https://cogni-web-psi.vercel.app/api/mcp",
  "apiKey": "cog_ABC123",
  "authScheme": "query",
  "authParamName": "api_key"
}
\`\`\`

### Worked example — Bearer token
\`\`\`json
{ "name": "Acme", "slug": "acme", "transport": "http", "url": "https://api.acme.com/mcp", "apiKey": "sk-live-...", "authScheme": "bearer" }
\`\`\`

### Making it usable: attach it to an agent
Creating the server does NOT make any agent able to use it. To give its tools to an agent, pass **\`attachToAgentSlug\`** in the same call — e.g. add \`"attachToAgentSlug": "displacer"\`. (Or attach later with \`attach_mcp\`.) If you skip this, no agent can call the MCP's tools.

### Common mistakes
- ❌ creating the MCP then delegating, without attaching → the agent reports "I don't have that tool". Pass \`attachToAgentSlug\` or call \`attach_mcp\`.
- ❌ key inside \`url\` → ✅ key in \`apiKey\` + the matching \`authScheme\`/\`authParamName\`.
- ❌ omitting \`authParamName\` for header/query schemes → it is required (only \`bearer\` omits it).
- ❌ reusing a slug already in the workspace → choose a unique one.
`,
};
