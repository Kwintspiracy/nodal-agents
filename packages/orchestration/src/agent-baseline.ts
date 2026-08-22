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
 * Open/mid models that need firmer execution discipline — weaker instruction-
 * following, a habit of declaring a task done without checking, AND a habit of
 * over-exploring (re-verifying, re-listing, running diagnostic commands, writing
 * their own helper/conversion scripts) instead of using the tools and paths they
 * were given. Both failures observed live on MiniMax M3 / DeepSeek. Frontier
 * models (Claude/GPT) follow the baseline without this and get nothing extra —
 * mirrors how Hermes injects per-model execution guidance.
 */
const NEEDS_FIRMER_VERIFY = /deepseek|minimax|qwen|glm|gemma|kimi|mistral|llama/i;

const contentOfKind = (kind: 'baseline' | 'channel'): string[] =>
  systemSkills.filter((s) => skillKind(s) === kind).map((s) => s.content.trim());

/**
 * Memory discipline — every agent, orchestrator or worker. Injected as a
 * fixed block (not catalog-driven): unlike the verify/safe-tool-use content
 * above, this reacts to a concrete failure mode from the 2026-07-07 audit —
 * agents kept silently reusing a memory fact they had just proven wrong, and
 * separately saved "lessons" that were really micromanagement of OTHER agents
 * (e.g. a fabricated "do NOT search for workflows" rule) or outright
 * discovery bans, which then handicapped whichever agent loaded them next.
 */
const MEMORY_DISCIPLINE_BLOCK = `## Memory discipline

### Correct what's wrong

If a fact from your Persistent memory block turns out to be false in practice — a file path that doesn't exist, an invalid ID, a procedure that fails the way the memory said it wouldn't — you MUST call \`mark_memory_outdated\` on it with the reason, then \`save_memory\` the corrected fact once you have verified it. Never silently keep reusing a fact you just found to be wrong.

### What's worth saving

A fact you save via \`save_memory\` must describe something VERIFIED — an exact path you confirmed, a real ID, a preference the user stated, a procedure that actually worked. Never save a micromanagement rule for another agent, and never save a discovery ban (e.g. "don't search for X", "don't explore Y") — every agent stays free to check things for itself when what it was given turns out to be wrong.`;

/** Worker-only — capitalize durable discoveries before finishing (not the orchestrator's job: it delegates the work, it doesn't do it). */
const WORKER_DISCOVERY_BLOCK = `## Capitalize what you learn

When you discover something durable while working a task — the real path of a file or workflow, parameters that worked, a convention — save it via \`save_memory\` before you finish. One fact per call, short and verified.`;

/**
 * Orchestrator-only — delegation discipline. From the same audit: the root
 * agent was doing its workers' prep work itself, editing shared/template
 * files to smuggle in per-run parameters, and prescribing tools in briefs
 * that the target agent didn't actually have.
 */
const DELEGATION_DISCIPLINE_BLOCK = `## Delegation discipline

When you delegate: (1) pass the PARAMETERS in the brief (paths, prompts, values) — do not do the prep work yourself that the worker can do with its own tools; (2) NEVER edit a shared or template file to encode a run's parameters — templates are immutable, values are passed as arguments; (3) only name a specific tool in a brief if you know the target agent has it — otherwise state the expected RESULT (the worker returns it via \`return_result\`) and deliver it yourself once it comes back; (4) a brief states the goal, the parameters, and the constraints — not a step-by-step procedure that forbids the worker from adapting.`;

/** Layer 1 — intrinsic discipline for every agent (+ model-aware reinforcement). */
export function buildBaselineBlock(
  model: string,
  opts: {
    role?: 'agent' | 'orchestrator' | 'system';
    /**
     * False on the `cli-runtime` surface: that session has none of Nodal's
     * builtins.
     *
     * Three review passes were spent on WHICH parts to keep, and the answer is
     * none of them:
     *
     *  - pass 1 dropped the block wholesale, on the claim it was "entirely"
     *    built around builtins — that claim was wrong;
     *  - pass 2 restored the catalog part, because its RULES (verify before
     *    declaring done, confirm before destructive actions, fail loud, mirror
     *    the user's language, reuse instead of rebuild) genuinely depend on no
     *    tool;
     *  - pass 3 showed the restore reintroduced the problem, because those
     *    rules' TEXT does name tools: verify-before-done orders `file_read`
     *    after every write, workspace-hygiene names `file_write`, others reach
     *    for `skill_view` / `create_task`.
     *
     * The rules are portable; the prose carrying them is not. Rewriting it is a
     * CATALOG-layer job (invariant #3 — fix at the agent layer, never patch the
     * runtime), so this surface gets no catalog content at all rather than text
     * whose every instruction misses.
     *
     * What makes that acceptable: a Claude Code session is not undisciplined
     * without it — it arrives with its own harness and its own conventions.
     * Nodal's discipline was written for Nodal's tools; mixing the two gives an
     * agent orders it cannot follow, which is worse than not giving them.
     */
    nodalTools?: boolean;
  } = {},
): string {
  const nodalTools = opts.nodalTools !== false;
  if (!nodalTools) return '';
  const parts = contentOfKind('baseline');
  const reinforcement =
    parts.length > 0 && NEEDS_FIRMER_VERIFY.test(model)
      ? '\n\n**Especially you — execution discipline:** ' +
        'Actually run or check your work before you say a task is done, and never write tool output ' +
        'you did not really get back. Be decisive: once a check passes (e.g. dependencies report ' +
        'ready), DO the action — do not keep re-verifying, re-listing, or running diagnostic ' +
        'commands. Use the tools, scripts, and exact file paths you were given (a skill loaded ' +
        'with skill_view ships run_skill_script and ready-made workflows/templates) ' +
        'instead of writing ' +
        'your own helper or conversion scripts, or rebuilding what already exists. Take the fewest ' +
        'steps that finish the task, then deliver the result with its output path.'
      : '';
  const catalogBlock =
    parts.length > 0 ? `## How you work (always)\n\n${parts.join('\n\n')}${reinforcement}` : '';

  const roleBlock =
    opts.role === 'orchestrator' ? DELEGATION_DISCIPLINE_BLOCK : WORKER_DISCOVERY_BLOCK;

  return [catalogBlock, MEMORY_DISCIPLINE_BLOCK, roleBlock].filter(Boolean).join('\n\n');
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
