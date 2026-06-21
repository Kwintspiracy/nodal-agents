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
const CONNECTOR_CAPABILITY: Record<string, string> = {
  tavily: 'Web search & page extraction — needs a Tavily API key (or a Perplexity MCP server)',
  firecrawl: 'Web scraping / crawling — needs a Firecrawl API key',
  apify: 'Web automation & scraping actors — needs an Apify token',
  gmail: 'Read and send email — connect a Google account',
  'google-drive': 'Google Drive files — connect a Google account',
  'google-sheets': 'Google Sheets — connect a Google account',
  'google-docs': 'Google Docs — connect a Google account',
  'notion-oauth': 'Notion pages & databases — connect Notion',
  notion: 'Notion pages & databases — connect Notion (internal integration key)',
  'airtable-oauth': 'Airtable bases — connect Airtable',
  airtable: 'Airtable bases — connect Airtable (personal access token)',
};

/**
 * Layer 2bis — advertise what the agent COULD do but doesn't have yet:
 * unassigned capability skills + unattached connectors. Index only (name + one
 * line) — the agent loads/requests the real thing on demand.
 */
export function buildDiscoverabilityBlock(
  assignedSkillSlugs: string[],
  attachedConnectorSlugs: string[],
): string {
  const assigned = new Set(assignedSkillSlugs);
  const skills = systemSkills.filter((s) => skillKind(s) === 'capability' && !assigned.has(s.slug));
  const attached = new Set(attachedConnectorSlugs);
  const connectors = Object.keys(CONNECTOR_CAPABILITY).filter(
    (slug) => slug in ADAPTER_REGISTRY && !attached.has(slug),
  );

  if (skills.length === 0 && connectors.length === 0) return '';

  const lines: string[] = [
    '## Capabilities you can request',
    '',
    'These are NOT active for you yet. If a task needs one, tell the user what you ' +
      'need and how to enable it — do NOT pretend you already can, and do NOT refuse flatly.',
  ];
  if (skills.length > 0) {
    lines.push('', 'Skills you can ask to be assigned:');
    for (const s of skills) lines.push(`- \`${s.slug}\` — ${s.description}`);
  }
  if (connectors.length > 0) {
    lines.push('', 'Capabilities the user can connect for you:');
    for (const slug of connectors) lines.push(`- ${CONNECTOR_CAPABILITY[slug]}`);
  }
  return lines.join('\n');
}
