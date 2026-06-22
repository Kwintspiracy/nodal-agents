// agent-baseline.ts — the behavior layers every agent gets, beyond its
// personality and assigned skills. Three layers (see the plan):
//   1. BASELINE  — intrinsic discipline injected into EVERY agent's prompt
//      (verify-before-done, safe-tool-use, language-mirror). Content comes from
//      the catalog skills flagged `kind: 'baseline'` — universal, not assignable.
//   2. CHANNEL   — per-channel etiquette injected when the agent is bound to a
//      channel (telegram formatting). Catalog skills flagged `kind: 'channel'`.
//   2bis. DISCOVERABILITY — the capability skills + connectors the agent does
//      NOT have yet, so it can offer them ("I can't search the web, but if you
//      add a Tavily key we can") instead of pretending or refusing flatly.
//
// Reading baseline/channel content from the catalog (not the DB) is deliberate:
// these are universal, never user-edited, and the catalog is the code's source
// of truth — so the prompt can never drift from a stale seed.

import { systemSkills, skillKind } from '@nodal-agents/catalog';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';

/**
 * Models that need a firmer verification nudge — weaker instruction-following or
 * a known habit of declaring a task done without actually checking (the exact
 * failure we hit live on DeepSeek/MiniMax). Frontier models get the baseline only.
 */
const NEEDS_FIRMER_VERIFY = /deepseek|minimax|qwen|glm|gemma|kimi|mistral|llama/i;

const contentOfKind = (kind: 'baseline' | 'channel'): string[] =>
  systemSkills.filter((s) => skillKind(s) === kind).map((s) => s.content.trim());

/** Layer 1 — intrinsic discipline for every agent (+ model-aware reinforcement). */
export function buildBaselineBlock(model: string): string {
  const parts = contentOfKind('baseline');
  if (parts.length === 0) return '';
  const reinforcement = NEEDS_FIRMER_VERIFY.test(model)
    ? '\n\n**Especially you:** actually run or check your work before you say a task ' +
      'is done, and never write tool output you did not really get back.'
    : '';
  return `## How you work (always)\n\n${parts.join('\n\n')}${reinforcement}`;
}

/** Layer 2 — per-channel etiquette, only when the agent is bound to a channel. */
export function buildChannelBlock(opts: { channel?: string; telegram?: boolean }): string {
  const onTelegram = opts.channel === 'telegram' || opts.telegram === true;
  if (!onTelegram) return '';
  const parts = contentOfKind('channel');
  if (parts.length === 0) return '';
  return `## Channel etiquette\n\n${parts.join('\n\n')}`;
}

/**
 * Curated "what this connector unlocks" hints, keyed by connector slug. Only
 * slugs present in ADAPTER_REGISTRY are ever advertised, so we never offer a
 * capability the runner can't actually wire up.
 */
const CONNECTOR_CAPABILITY: Record<string, { label: string; setup: string }> = {
  tavily: { label: 'Web search & page extraction', setup: 'a Tavily API key' },
  firecrawl: { label: 'Web scraping / crawling', setup: 'a Firecrawl API key' },
  apify: { label: 'Web automation & scraping actors', setup: 'an Apify token' },
  gmail: { label: 'Read and send email', setup: 'a connected Google account' },
  'google-calendar': { label: 'Google Calendar events', setup: 'a connected Google account' },
  'google-drive': { label: 'Google Drive files', setup: 'a connected Google account' },
  'google-sheets': { label: 'Google Sheets', setup: 'a connected Google account' },
  'google-docs': { label: 'Google Docs', setup: 'a connected Google account' },
  'notion-oauth': { label: 'Notion pages & databases', setup: 'a connected Notion account' },
  notion: { label: 'Notion pages & databases', setup: 'a Notion internal-integration key' },
  'airtable-oauth': { label: 'Airtable bases', setup: 'a connected Airtable account' },
  airtable: { label: 'Airtable bases', setup: 'an Airtable personal access token' },
};

const labelForConnector = (slug: string, name: string): string =>
  CONNECTOR_CAPABILITY[slug]?.label ?? name;

export interface DiscoverabilityInput {
  /** Capability skills already assigned to this agent. */
  assignedSkillSlugs: string[];
  /** Connectors attached to this agent. */
  attachedConnectorSlugs: string[];
  /** MCP servers attached to this agent. */
  attachedMcpSlugs: string[];
  /** Connectors CONFIGURED in the workspace (have a credential) — slug + name. */
  workspaceConnectors: { slug: string; name: string }[];
  /** MCP servers CONFIGURED in the workspace — slug + name. */
  workspaceMcps: { slug: string; name: string }[];
}

/**
 * Layer 2bis — advertise what the agent COULD do but doesn't have yet, with the
 * THREE distinct states so it never tells the user to set up something that is
 * already there:
 *   - already configured in the workspace but not attached to this agent →
 *     "it's set up — just needs to be assigned to you" (NO new key required);
 *   - a capability with no connector configured at all → "needs <setup>";
 *   - capability skills not assigned → can be assigned.
 */
export function buildDiscoverabilityBlock(input: DiscoverabilityInput): string {
  const assignedSkills = new Set(input.assignedSkillSlugs);
  const skills = systemSkills.filter(
    (s) => skillKind(s) === 'capability' && !assignedSkills.has(s.slug),
  );

  const attachedConn = new Set(input.attachedConnectorSlugs);
  const attachedMcp = new Set(input.attachedMcpSlugs);

  // State 1: configured in the workspace but not attached to THIS agent.
  const readyConnectors = input.workspaceConnectors.filter((c) => !attachedConn.has(c.slug));
  const readyMcps = input.workspaceMcps.filter((m) => !attachedMcp.has(m.slug));

  // State 2: a known capability with NO connector configured at all (and not
  // already attached) → would need the user to add a credential.
  const configuredConnSlugs = new Set(input.workspaceConnectors.map((c) => c.slug));
  const notSetUp = Object.entries(CONNECTOR_CAPABILITY).filter(
    ([slug]) =>
      slug in ADAPTER_REGISTRY && !attachedConn.has(slug) && !configuredConnSlugs.has(slug),
  );

  if (
    skills.length === 0 &&
    readyConnectors.length === 0 &&
    readyMcps.length === 0 &&
    notSetUp.length === 0
  ) {
    return '';
  }

  const lines: string[] = [
    '## Capabilities you can request',
    '',
    'These are NOT active for YOU yet. Use the right one below — do NOT pretend you ' +
      'already can, do NOT refuse flatly, and do NOT ask the user to set up something ' +
      'that is already configured.',
  ];

  if (skills.length > 0) {
    lines.push('', 'Skills you can ask to be assigned:');
    for (const s of skills) lines.push(`- \`${s.slug}\` — ${s.description}`);
  }

  if (readyConnectors.length > 0 || readyMcps.length > 0) {
    lines.push(
      '',
      'ALREADY configured in this workspace — just needs to be assigned to you ' +
        '(NO new API key needed; if you are the workspace ROOT, use ' +
        '`attach_connector` / `attach_mcp`, otherwise ask the user to assign it):',
    );
    for (const c of readyConnectors)
      lines.push(`- ${labelForConnector(c.slug, c.name)} — connector \`${c.slug}\` (configured)`);
    for (const m of readyMcps) lines.push(`- ${m.name} — MCP server \`${m.slug}\` (configured)`);
  }

  if (notSetUp.length > 0) {
    lines.push('', 'Not set up in this workspace yet — would need the user to add:');
    for (const [, cap] of notSetUp) lines.push(`- ${cap.label} — needs ${cap.setup}`);
  }

  return lines.join('\n');
}
