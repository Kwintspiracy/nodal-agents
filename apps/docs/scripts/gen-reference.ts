/**
 * gen-reference.ts — generate the catalog-driven half of the "Reference" docs
 * section from the live product catalogs. Run before `next dev` / `next build`
 * (see package.json scripts).
 *
 * The product catalogs (@nodal-agents/catalog system skills, the connector +
 * MCP + model catalogs in @nodal-agents/shared / apps/web, the adapter
 * `*_OPERATIONS` inventories, and the ROOT `RootGrants` interface) are the
 * SINGLE SOURCE OF TRUTH. By regenerating these pages from them at build time,
 * the docs can never drift from what the product actually ships — change a
 * catalog entry, the docs regenerate. This is the "dynamic" half of the
 * documentation; the hand-written pages (index, cli, dashboard, operate, api,
 * skills) are committed and left untouched.
 *
 * Skill pages are written as `.md` (NOT `.mdx`): the skill content is arbitrary
 * Markdown authored for LLM prompts and contains `{ }` (JSON examples) and
 * `<placeholder>` tokens that would break the MDX compiler. In `.md` mode MDX
 * expression/JSX parsing is off (`{` is literal), and we escape `<` outside code
 * spans so `<step>` renders as text instead of being eaten as an HTML tag. The
 * catalog tables (connectors / mcp / models) are clean Markdown, so they are
 * written as `.mdx`.
 *
 * THIS GENERATOR ONLY OWNS THESE SUBDIRS (wiped + regenerated each run):
 *   reference/system-skills/   — one page per system skill + nav
 *   reference/connectors/      — one page per connector + tool inventory + nav
 *   reference/mcp/             — one page per MCP catalog entry + nav
 *   reference/models/          — model catalog table + ROOT grants table + nav
 *   reference/builtin-tools/   — built-in tool registry reference + nav
 *
 * It NEVER deletes the hand-written, committed files that live alongside:
 *   reference/index.mdx, reference/meta.json, reference/skills.mdx,
 *   reference/cli.mdx, reference/dashboard.mdx, reference/operate.mdx,
 *   reference/api.mdx
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemSkills, skillKind, type SystemSkill } from '@nodal-agents/catalog';
import {
  CONNECTOR_CATALOG,
  MODEL_CATALOG,
  VISION_MODEL_IDS,
  DEFAULT_ROOT_GRANTS,
  modelGroupLabel,
  type RootGrants,
  type OperationDescriptor,
} from '@nodal-agents/shared';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import {
  createToolRegistry,
  registerBuiltins,
  ALWAYS_ON_TOOLS,
  createTelegramSendMessageTool,
  createSendImageTool,
  createSendFileTool,
  createSendVideoTool,
  createSendAudioTool,
  createSendVoiceTool,
  createListConversationsTool,
  type RiskLevel,
} from '@nodal-agents/tools';

/** The subset of a ToolDefinition this generator reads (avoids the zod generic). */
type ToolInfo = {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  defaultApproval?: 'require_approval';
};
// The MCP catalog still lives inside apps/web (it is a pure-data module with no
// imports, so tsx resolves the relative path fine). Lift into a shared package
// later if a second consumer appears.
import { MCP_CATALOG } from '@nodal-agents/shared';

const here = dirname(fileURLToPath(import.meta.url));
const refDir = join(here, '..', 'content', 'docs', 'reference');
const systemSkillsDir = join(refDir, 'system-skills');
const connectorsDir = join(refDir, 'connectors');
const mcpDir = join(refDir, 'mcp');
const modelsDir = join(refDir, 'models');
const builtinToolsDir = join(refDir, 'builtin-tools');

// Idempotent: wipe + recreate ONLY the subdirs this generator owns, so removed
// catalog entries don't leave stale pages. The hand-written reference pages
// (index.mdx, meta.json, skills.mdx, cli.mdx, dashboard.mdx, operate.mdx,
// api.mdx) are left in place.
for (const dir of [systemSkillsDir, connectorsDir, mcpDir, modelsDir, builtinToolsDir]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** One-line, frontmatter-safe (JSON-quoted = valid YAML double-quoted scalar). */
const fm = (v: string): string => JSON.stringify(v.replace(/\s+/g, ' ').trim());

/** Escape a `|` so it doesn't break a Markdown table cell, and collapse newlines. */
const cell = (v: string): string => v.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

/**
 * Neutralise raw `<tag>` tokens that CommonMark would parse as HTML (swallowing
 * the following text), but ONLY outside code spans/fences — inside code, `<` is
 * already literal and must be left untouched. Splitting on a capturing group
 * keeps the code segments at odd indices.
 */
const escapeAnglesOutsideCode = (md: string): string =>
  md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/</g, '&lt;')))
    .join('');

// ── System skills: one page per skill ───────────────────────────────────────────
const renderSkillPage = (skill: SystemSkill): string => {
  const unlocks =
    skill.requiredBuiltins && skill.requiredBuiltins.length > 0
      ? `\n**Unlocks tools:** ${skill.requiredBuiltins.map((b) => '`' + b + '`').join(', ')}`
      : '';
  const kind = skillKind(skill);
  const internalNote =
    kind === 'agent-internal'
      ? `\n**Agent-internal:** loaded on demand via \`skill_view\` (hidden from the dashboard library, not user-assigned).`
      : kind === 'baseline'
        ? `\n**Baseline:** intrinsic — injected into EVERY agent's base prompt by default (not assignable).`
        : kind === 'channel'
          ? `\n**Channel:** injected automatically when the agent is bound to a channel (not assignable).`
          : '';
  return `---
title: ${fm(skill.name)}
description: ${fm(skill.description)}
---

${skill.description}

**Slug:** \`${skill.slug}\`${unlocks}${internalNote}

> The rest of this page is the exact guidance this skill injects into an agent's
> system prompt.

---

${escapeAnglesOutsideCode(skill.content.trim())}
`;
};

const writeSkillSection = (dir: string, title: string, list: SystemSkill[]): string[] => {
  const slugs = list.map((s) => s.slug);
  for (const skill of list) writeFileSync(join(dir, `${skill.slug}.md`), renderSkillPage(skill));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ title, pages: slugs }, null, 2) + '\n');
  return slugs;
};

const sysSlugs = writeSkillSection(systemSkillsDir, 'System skills', systemSkills);

// ── Connectors: one page per catalog entry + adapter tool inventory ──────────────
const RISK_LABEL: Record<OperationDescriptor['risk'], string> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Destructive',
};
const RISK_ORDER: Array<OperationDescriptor['risk']> = ['read', 'write', 'destructive'];

const opsTable = (ops: OperationDescriptor[]): string => {
  const sections: string[] = [];
  for (const risk of RISK_ORDER) {
    const group = ops.filter((o) => o.risk === risk);
    if (group.length === 0) continue;
    const rows = group
      .map((o) => `| \`${o.slug}\` | ${cell(o.name)} | ${cell(o.description ?? '')} |`)
      .join('\n');
    sections.push(
      `### ${RISK_LABEL[risk]} (${group.length})\n\n` +
        `| Tool | Operation | Description |\n| --- | --- | --- |\n${rows}`,
    );
  }
  return sections.join('\n\n');
};

const connectorSlugs: string[] = [];
for (const c of CONNECTOR_CATALOG) {
  connectorSlugs.push(c.slug);
  const adapter = ADAPTER_REGISTRY[c.slug];
  const ops = adapter?.operations ?? [];
  const authLine =
    c.authType === 'oauth2'
      ? `**Auth:** OAuth 2.0${c.credentialType ? ` (credential type \`${c.credentialType}\`)` : ''}`
      : `**Auth:** API key`;
  const inventory =
    ops.length > 0
      ? `## Tools (${ops.length})\n\n${opsTable(ops)}`
      : `## Tools\n\nThis connector has no adapter operation inventory in the catalog yet — only its auth and setup are documented above.`;
  writeFileSync(
    join(connectorsDir, `${c.slug}.mdx`),
    `---
title: ${fm(c.label)}
description: ${fm(`${c.label} connector — ${c.docsHint}`)}
---

${authLine}

**Slug:** \`${c.slug}\`

**Setup:** ${c.docsHint}

> **Destructive operations** (delete, overwrite) can be disabled per-agent: in
> the agent's **Connectors** tab, the "enabled operations" allowlist controls
> exactly which of the tools below an agent may call. Operations marked
> **Destructive** below are the ones to review first.

${inventory}
`,
  );
}
writeFileSync(
  join(connectorsDir, 'meta.json'),
  JSON.stringify({ title: 'Connectors', pages: connectorSlugs }, null, 2) + '\n',
);

// ── MCP: one page per catalog entry ──────────────────────────────────────────────
// Several catalog entries share a slug (e.g. `airtable`, `notion` appear as both
// a direct connector AND an MCP server). De-dupe the page filename by suffixing
// the transport so each entry gets its own page.
const usedMcpNames = new Set<string>();
const mcpPages: string[] = [];
for (const m of MCP_CATALOG) {
  let page = m.slug;
  if (usedMcpNames.has(page)) page = `${m.slug}-${m.transport}`;
  let n = 2;
  while (usedMcpNames.has(page)) page = `${m.slug}-${m.transport}-${n++}`;
  usedMcpNames.add(page);
  mcpPages.push(page);

  const status = m.status === 'pending' ? ' (test pending)' : '';
  const transport = m.transport === 'http' ? 'Streamable HTTP' : 'stdio (local subprocess)';
  const authScheme =
    m.transport === 'stdio'
      ? 'n/a (local subprocess — uses env vars, not an HTTP key)'
      : m.authScheme === 'bearer'
        ? 'Bearer token'
        : m.authScheme === 'header'
          ? `Header \`${m.authParamName}\``
          : `Query param \`${m.authParamName}\``;
  const facts = [
    `**Transport:** ${transport}`,
    `**Auth:** ${authScheme}`,
    m.serverUrl ? `**Server URL:** \`${m.serverUrl}\`` : null,
    m.command ? `**Command:** \`${[m.command, ...(m.args ?? [])].join(' ')}\`` : null,
    m.envVarNames && m.envVarNames.length > 0
      ? `**Env vars:** ${m.envVarNames.map((e) => '`' + e + '`').join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Written as `.md` (NOT `.mdx`): MCP docsHints are free-form and contain both
  // `{ }` (a JSON header example in the Notion hint) and `<placeholder>` tokens
  // (`<connection-string>`) that the MDX compiler would choke on. In `.md` mode
  // `{` is literal; we still escape `<` outside code spans so `<repo-path>`
  // renders as text instead of being eaten as an HTML tag — same rule the skill
  // pages use.
  writeFileSync(
    join(mcpDir, `${page}.md`),
    `---
title: ${fm(`${m.label}${status}`)}
description: ${fm(m.description)}
---

${escapeAnglesOutsideCode(m.description)}

**Slug:** \`${m.slug}\`

${facts}

**Setup:** ${escapeAnglesOutsideCode(m.docsHint)}
`,
  );
}
writeFileSync(
  join(mcpDir, 'meta.json'),
  JSON.stringify({ title: 'MCP connectors', pages: mcpPages }, null, 2) + '\n',
);

// ── Models + ROOT grants ─────────────────────────────────────────────────────────
// One generated section the generator owns: a models table (provider + vision +
// reasoning, all from the catalog) and the full ROOT grants table (from the
// RootGrants interface — every field, defaults-sourced for the value column).
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};
const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? p;
const yesno = (b: boolean): string => (b ? 'Yes' : 'No');

const modelRows: string[] = [];
for (const [provider, entries] of Object.entries(MODEL_CATALOG)) {
  for (const e of entries) {
    const group = modelGroupLabel(e.modelId);
    const providerCell =
      group && provider === 'openrouter' ? `OpenRouter / ${group}` : providerLabel(provider);
    modelRows.push(
      `| ${cell(e.label)} | \`${e.modelId}\` | ${providerCell} | ${yesno(
        VISION_MODEL_IDS.has(e.modelId),
      )} | ${yesno(Boolean(e.capabilities.reasoning))} |`,
    );
  }
}
const modelCount = modelRows.length;

writeFileSync(
  join(modelsDir, 'models.mdx'),
  `---
title: Models
description: Curated LLM models Nodal-Agents pre-fills with the right capability flags (vision, reasoning).
---

These are the models in the curated catalog — the ones Nodal-Agents pre-fills
with correct capability flags (tool calling, image input, reasoning). They are a
convenience layer: you can always point an agent at any other model via the
**Custom…** field plus the live "Test" probe, which is the source of truth for
anything not listed here.

- **Vision** — the model accepts image input (sourced from the providers
  themselves: OpenRouter \`/api/v1/models\` and models.dev). An inbound image is
  only sent to a vision-capable model, and the orchestrator can route an image
  to a vision-capable teammate.
- **Reasoning** — the model emits a hidden chain-of-thought that the runner
  round-trips across tool calls.

| Model | Model ID | Provider | Vision | Reasoning |
| --- | --- | --- | --- | --- |
${modelRows.join('\n')}
`,
);

// ROOT grants — every field of the RootGrants interface, with a one-line meaning
// and the default value. Keys come from DEFAULT_ROOT_GRANTS so a new grant field
// is never silently dropped (TS keyof check below makes a missing description a
// compile error).
const GRANT_MEANING: Record<keyof RootGrants, string> = {
  createAgent: 'Create new sub-agents (the `create_agent` meta-tool).',
  updateAgent: "Edit an existing agent's model or personality (`update_agent`).",
  attachAgent: 'Attach / detach an existing agent as a sub-agent (`attach_agent`, `detach_agent`).',
  createSkill: 'Author a new skill (`create_skill`).',
  updateSkill: 'Edit an existing skill (`update_skill`).',
  assignSkill: 'Assign / unassign a skill to an agent (`attach_skill`, `detach_skill`).',
  createMcp: 'Connect a new MCP server (`create_mcp`).',
  attachMcp: 'Attach / detach an MCP server to an agent (`attach_mcp`, `detach_mcp`).',
  createConnector: 'Connect a new connector (`create_connector`).',
  attachConnector:
    'Attach / detach a connector to an agent (`attach_connector`, `detach_connector`).',
  manageSchedules:
    'Create, edit, toggle, and run cron schedules (`create_schedule`, `update_schedule`, `toggle_schedule`, `run_schedule`).',
  autonomy:
    'Autonomy level for the ROOT meta-tools: `propose_confirm`, `destructive_gate`, or `fully_autonomous`.',
};
const grantRows = (Object.keys(GRANT_MEANING) as Array<keyof RootGrants>)
  .map((k) => {
    const def = DEFAULT_ROOT_GRANTS[k];
    const defCell = typeof def === 'boolean' ? yesno(def) : `\`${def}\``;
    return `| \`${k}\` | ${cell(GRANT_MEANING[k])} | ${defCell} |`;
  })
  .join('\n');

writeFileSync(
  join(modelsDir, 'root-grants.mdx'),
  `---
title: ROOT grants
description: The per-grant powers a ROOT agent can be given — every field of the RootGrants interface.
---

A **ROOT agent** is the top of an entity's hierarchy and the target of the
dashboard chat. It can hold *meta-tools* that change your setup (create agents,
author skills, connect MCP servers, manage schedules). Each power is a separate
grant you toggle in **Settings → ROOT agent**, gated by the ROOT's autonomy
level. The table below is every grant on the \`RootGrants\` interface.

The **Default** column is the value a manually-designated ROOT starts with
(\`DEFAULT_ROOT_GRANTS\`). An *auto-designated* ROOT — the first orchestrator
created in an entity — instead starts with every power **off** until you opt in.

| Grant | Meaning | Default |
| --- | --- | --- |
${grantRows}
`,
);

writeFileSync(
  join(modelsDir, 'meta.json'),
  JSON.stringify({ title: 'Models & grants', pages: ['models', 'root-grants'] }, null, 2) + '\n',
);

// ── Built-in tools ────────────────────────────────────────────────────────────────
// Enumerate the built-in tool registry (registerBuiltins is the single source of
// truth for what ships). For each tool we emit its name, description, risk level,
// whether it is always-on (ALWAYS_ON_TOOLS), and how it is unlocked when it is
// NOT always-on — derived, never hardcoded:
//   - via a system skill's `requiredBuiltins` (office-editing, command-execution, …);
//   - a ROOT meta-tool gated by a `RootGrants` power (create_agent, create_skill, …);
//   - a per-agent×skill authorization toggle (run_skill_script, skill_file_write).
// A single generated page groups tools into "Always-on" and "Unlocked on demand".
const builtinRegistry = createToolRegistry();
registerBuiltins(builtinRegistry);
const builtinTools = builtinRegistry
  .list()
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name));

const alwaysOnNames = new Set<string>(ALWAYS_ON_TOOLS);

// builtin tool name → the system skill whose requiredBuiltins lists it. The
// catalog is the source of truth, so a re-gated tool re-labels itself.
const skillUnlocking = new Map<string, SystemSkill>();
for (const skill of systemSkills) {
  for (const b of skill.requiredBuiltins ?? []) {
    if (!skillUnlocking.has(b)) skillUnlocking.set(b, skill);
  }
}

// The ROOT meta-tools, keyed to the RootGrants power that gates them. Names come
// from the DEFAULT_ROOT_GRANTS keys' meaning strings above (GRANT_MEANING already
// spells out every meta-tool name), so this stays in lockstep with the grants
// table — extracting the `tool_name` tokens keeps a new meta-tool from being
// silently mislabelled as "unknown".
const metaToolGrant = new Map<string, keyof RootGrants>();
for (const grant of Object.keys(GRANT_MEANING) as Array<keyof RootGrants>) {
  for (const [, toolName] of GRANT_MEANING[grant].matchAll(/`([a-z_]+)`/g)) {
    metaToolGrant.set(toolName, grant);
  }
}

const RISK_TOOL_LABEL: Record<ToolInfo['riskLevel'], string> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Destructive',
};

/** How a non-always-on tool is unlocked. Returns null for always-on tools. */
const unlockNote = (name: string): string | null => {
  if (alwaysOnNames.has(name)) return null;
  const skill = skillUnlocking.get(name);
  if (skill) return `Skill \`${skill.slug}\` (${skill.name})`;
  const grant = metaToolGrant.get(name);
  if (grant) return `ROOT grant \`${String(grant)}\``;
  // Per-agent × skill authorization toggles (not a requiredBuiltins skill).
  if (name === 'run_skill_script') return 'Per-agent script authorization (a script-bundled skill)';
  if (name === 'skill_file_write')
    return 'Per-agent file-write authorization (a file-writable skill)';
  return 'Gated (not always-on)';
};

const toolRow = (t: ToolInfo): string => {
  const approval = t.defaultApproval === 'require_approval' ? ' *(approval by default)*' : '';
  // Written to a `.md` page (below): `{` is literal, but raw `<` tokens still
  // need escaping outside code spans. Tool descriptions are prose (no code
  // fences), so this is a straight angle-escape of the collapsed cell text.
  const desc = escapeAnglesOutsideCode(cell(t.description));
  return `| \`${t.name}\` | ${RISK_TOOL_LABEL[t.riskLevel]}${approval} | ${desc} |`;
};

const alwaysOnTools = builtinTools.filter((t) => alwaysOnNames.has(t.name));
const gatedTools = builtinTools.filter((t) => !alwaysOnNames.has(t.name));

const alwaysOnTable =
  `| Tool | Risk | Description |\n| --- | --- | --- |\n` + alwaysOnTools.map(toolRow).join('\n');

// Group the gated tools by how they are unlocked so the reference reads by concern.
const gatedGroups = new Map<string, ToolInfo[]>();
for (const t of gatedTools) {
  const key = unlockNote(t.name) ?? 'Gated (not always-on)';
  const arr = gatedGroups.get(key) ?? [];
  arr.push(t);
  gatedGroups.set(key, arr);
}
const gatedSections = [...gatedGroups.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([unlock, tools]) => {
    const rows = tools.map(toolRow).join('\n');
    return `### Unlocked by: ${unlock}\n\n| Tool | Risk | Description |\n| --- | --- | --- |\n${rows}`;
  })
  .join('\n\n');

// Channel tools — capability-driven like SKILL_TOOLS, but NOT part of
// registerBuiltins at all: the runner adds these to an agent's whitelist per
// JOB, only when the agent has an active channel binding (a Telegram bot
// token, or an enabled channel_bindings row for Discord/Slack/WhatsApp — see
// apps/runner/src/job/execute.ts). Because they never enter the registry
// created above, builtinRegistry.list() can't see them; call each factory
// directly so this section stays sourced from the same tool definitions the
// runtime actually registers, not a hand-copied description.
const channelTools: ToolInfo[] = [
  createTelegramSendMessageTool(),
  createSendImageTool(),
  createSendFileTool(),
  createSendVideoTool(),
  createSendAudioTool(),
  createSendVoiceTool(),
  createListConversationsTool(),
].sort((a, b) => a.name.localeCompare(b.name));

const channelTable =
  `| Tool | Risk | Description |\n| --- | --- | --- |\n` + channelTools.map(toolRow).join('\n');

// Written as `.md` (NOT `.mdx`): several tool descriptions contain `{ }`
// (a JSON example in dashboard_publish's `response.content = [{…}]`) and `<…>`
// tokens (`<server-slug>__<tool>` in create_skill) that the MDX compiler would
// choke on. In `.md` mode `{` is literal and toolRow() escapes `<` outside code
// spans — the same rule the skill + MCP pages use.
writeFileSync(
  join(builtinToolsDir, 'builtin-tools.md'),
  `---
title: Built-in tools
description: The tools every Nodal-Agents runtime registers — always-on plus the skill- and grant-gated ones — generated from the tool registry.
---

Every agent runs on the same built-in tool registry (\`registerBuiltins\`). This
page is generated from that registry, so it can never drift from what the runtime
actually exposes. Adapter (connector) and MCP tools are documented on their own
pages — this is the runtime's own toolbox.

Each tool carries a **risk level** (\`read\` / \`write\` / \`destructive\`) that
drives the approval and autonomy gates. Tools marked *(approval by default)* are
safe-by-default: they suspend for human approval unless an explicit
\`auto_approve\` ("Yolo") rule overrides them.

## Always-on (${alwaysOnTools.length})

These tools are in every agent's whitelist by default (\`ALWAYS_ON_TOOLS\`) — no
skill, connector, or grant required.

${alwaysOnTable}

## Unlocked on demand (${gatedTools.length})

These tools are **not** always-on. Each is added to an agent's whitelist only
when the agent holds the skill, ROOT grant, or per-agent authorization noted
below — never by default.

${gatedSections}

## Channel tools (require an active channel binding) (${channelTools.length})

These tools are capability-driven, but unlike the "unlocked on demand" tools
above they are not part of \`registerBuiltins\` at all: the runner adds them to
an agent's whitelist per job only when the agent has an active channel binding
(a Telegram bot token, or an enabled channel connection for Discord, Slack, or
WhatsApp). No skill or ROOT grant is required — connecting the channel is what
unlocks them.

${channelTable}
`,
);

writeFileSync(
  join(builtinToolsDir, 'meta.json'),
  JSON.stringify({ title: 'Built-in tools', pages: ['builtin-tools'] }, null, 2) + '\n',
);

console.log(
  `[gen-reference] wrote ${sysSlugs.length} system skills, ` +
    `${connectorSlugs.length} connectors (${connectorSlugs.reduce(
      (n, s) => n + (ADAPTER_REGISTRY[s]?.operations.length ?? 0),
      0,
    )} tools), ` +
    `${mcpPages.length} MCP entries, ${modelCount} models, ROOT grants table, ` +
    `${builtinTools.length} built-in tools (${alwaysOnTools.length} always-on, ${gatedTools.length} gated), ` +
    `${channelTools.length} channel tools`,
);
