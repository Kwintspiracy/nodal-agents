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

import { systemSkills, skillKind, skillContentOn } from '@nodal-agents/catalog';
import type { PromptSurface } from '@nodal-agents/catalog';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { CHANNELS, AUTOMATION_KINDS } from '@nodal-agents/shared';

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

/**
 * Le texte d'une skill POUR une surface.
 *
 * Deux façons d'être présent sur `chat` : déclarer la surface — tout le texte
 * s'y suit —, ou écrire `contentOnChat`, ce qui en reste vrai sans aucun outil.
 * Le second existe parce que le premier est un interrupteur : il emportait les
 * règles portables avec celles qui prescrivent un outil, et le chat en devenait
 * PLUS enclin à affirmer sans preuve (revue Codex de la dette de la PR #73,
 * constat 1). Les deux vivent dans le CATALOGUE (invariant #3).
 */
const contentOfKind = (
  kind: 'baseline' | 'channel',
  surface: PromptSurface = 'job',
  availableTools?: readonly string[],
): string[] =>
  systemSkills
    .filter((s) => skillKind(s) === kind)
    .filter((s) => hasRequiredBuiltins(s, availableTools))
    .map((s) => skillContentOn(s, surface))
    .filter((text): text is string => text !== null);

/**
 * Une skill de socle peut DÉPENDRE d'un outil — `platform-support` ne dit que
 * « appelle `nodal_docs` ». Elle le déclare dans `requiredBuiltins`, le même
 * champ qui sert déjà à ouvrir un builtin gaté pour un worker ; ici il sert à
 * ne PAS injecter un texte qui promettrait un outil absent.
 *
 * FERMÉ PAR DÉFAUT : sans liste d'outils connue, une skill qui en exige un
 * reste dehors. L'inverse — l'injecter dans le doute — redonnerait à l'agent
 * des ordres inexécutables, ce que les trois passes de revue sur `surfaces`
 * ont déjà payé une fois. Une skill sans `requiredBuiltins` n'est jamais
 * concernée, donc rien de ce qui existait ne change.
 */
const hasRequiredBuiltins = (
  skill: { requiredBuiltins?: string[] },
  availableTools?: readonly string[],
): boolean => {
  const needed = skill.requiredBuiltins ?? [];
  if (needed.length === 0) return true;
  if (availableTools === undefined) return false;
  return needed.every((tool) => availableTools.includes(tool));
};

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

A fact you save via \`save_memory\` must describe something VERIFIED — an exact path you confirmed, a real ID, a preference the user stated, a procedure that actually worked. Never save a micromanagement rule for another agent, and never save a discovery ban (e.g. "don't search for X", "don't explore Y") — every agent stays free to check things for itself when what it was given turns out to be wrong.

Memory is what you KNOW, never a log of what you DID. Do not save "I created file X", "I posted the announcement", "run completed" — the file, the message and the run are their own record, and an account of one job is worthless to the next. If you are a scheduled routine and you need to recognise this run against the last one, that is \`save_routine_state\`, not memory.`;

/** Worker-only — capitalize durable discoveries before finishing (not the orchestrator's job: it delegates the work, it doesn't do it). */
const WORKER_DISCOVERY_BLOCK = `## Capitalize what you learn

When you discover something durable while working a task — the real path of a file or workflow, parameters that worked, a convention — save it via \`save_memory\` before you finish. One fact per call, short and verified.`;

/**
 * Le même bloc SANS son outil — donc sans un ordre que la surface ne peut pas
 * exécuter.
 *
 * Sur `chat`, `save_memory` n'existe pas : la phrase entière était
 * inexécutable, et elle passait quand même (revue Codex de la dette de la
 * PR #73, constat 2 — la PR promettait « rien que d'exécutable » et ne
 * vérifiait que des titres). La retirer tout court aurait retiré la règle ; la
 * règle reste vraie ici, seul le geste change.
 */
const WORKER_DISCOVERY_BLOCK_CHAT = `## Capitalize what you learn

When you discover something durable in conversation — the real path of a file or workflow, parameters that worked, a convention — it is worth keeping. You cannot record it from here: put the fact itself in the brief of the job that will need it.`;

/**
 * Orchestrator-only — delegation discipline. From the same audit: the root
 * agent was doing its workers' prep work itself, editing shared/template
 * files to smuggle in per-run parameters, and prescribing tools in briefs
 * that the target agent didn't actually have.
 */
const DELEGATION_DISCIPLINE_BLOCK = `## Delegation discipline

When you delegate: (1) pass the PARAMETERS in the brief (paths, prompts, values) — do not do the prep work yourself that the worker can do with its own tools; (2) NEVER edit a shared or template file to encode a run's parameters — templates are immutable, values are passed as arguments; (3) only name a specific tool in a brief if you know the target agent has it — otherwise state the expected RESULT (the worker returns it via \`return_result\`) and deliver it yourself once it comes back; (4) a brief states the goal, the parameters, and the constraints — not a step-by-step procedure that forbids the worker from adapting.`;

/**
 * La même discipline, dite pour une surface qui ne délègue pas elle-même.
 *
 * Sur `chat`, l'agent n'a pas d'outil de délégation : il escalade par
 * `run_task`, et c'est le job ainsi créé qui délègue. Nommer ici les outils du
 * worker donnait des ordres inexécutables (revue Codex de la dette de la
 * PR #73, constat 2), alors que ce qui vaut sur cette surface — ce qu'un brief
 * doit porter — est exactement le même.
 */
const DELEGATION_DISCIPLINE_BLOCK_CHAT = `## Delegation discipline

What you hand off is a brief, and it carries: (1) the PARAMETERS — paths, prompts, values, the user's own words where they matter; (2) the goal and the constraints, never a step-by-step procedure that stops the worker adapting; (3) the expected RESULT rather than the means of getting it. Do not do a worker's prep work in conversation, and never rewrite a shared or template file to carry a run's values.`;

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
    /**
     * La surface qui recevra ce bloc. `chat` a UN outil (`run_task`) : les
     * skills baseline dont le texte prescrit des outils de fichiers n'y sont
     * pas injectées (elles le déclarent, `SystemSkill.surfaces`), et la
     * discipline de mémoire non plus — elle ordonne `save_memory`, que le chat
     * n'a pas. Mesuré le 12/09/2026 : ~4 200 jetons d'ordres inexécutables par
     * tour de chat, retirés par la même règle que pour `cli-runtime`.
     */
    surface?: PromptSurface;
    /**
     * Les outils que cet agent a RÉELLEMENT pour ce job. Sert à une seule
     * chose ici : décider si une skill de socle qui EXIGE un outil est
     * injectée (voir `hasRequiredBuiltins`). Omis = aucune skill exigeante
     * n'est injectée, jamais l'inverse.
     */
    availableTools?: readonly string[];
  } = {},
): string {
  const nodalTools = opts.nodalTools !== false;
  if (!nodalTools) return '';
  const surface = opts.surface ?? 'job';
  const parts = contentOfKind('baseline', surface, opts.availableTools);
  // Le renforcement nomme `skill_view` et `run_skill_script` : deux outils de
  // plus que le chat n'a pas, et deux ordres de plus qu'il ne peut pas suivre
  // (revue Codex de la dette de la PR #73, constat 2). Sa moitié portable —
  // vérifier avant de dire que c'est fait, ne jamais inventer une sortie
  // d'outil, être décisif — vaut sur les deux surfaces et reste sur les deux.
  const reinforcement =
    parts.length === 0 || !NEEDS_FIRMER_VERIFY.test(model)
      ? ''
      : surface === 'chat'
        ? '\n\n**Especially you — execution discipline:** ' +
          'Actually check your work before you say something is done, and never write tool output ' +
          'you did not really get back. Be decisive: once you know what the user is asking for, ' +
          'hand it over as one job instead of re-asking, re-listing, or narrating what you are ' +
          'about to do. Take the fewest steps that finish the task.'
        : '\n\n**Especially you — execution discipline:** ' +
          'Actually run or check your work before you say a task is done, and never write tool output ' +
          'you did not really get back. Be decisive: once a check passes (e.g. dependencies report ' +
          'ready), DO the action — do not keep re-verifying, re-listing, or running diagnostic ' +
          'commands. Use the tools, scripts, and exact file paths you were given (a skill loaded ' +
          'with skill_view ships run_skill_script and ready-made workflows/templates) ' +
          'instead of writing ' +
          'your own helper or conversion scripts, or rebuilding what already exists. Take the fewest ' +
          'steps that finish the task, then deliver the result with its output path.';
  const catalogBlock =
    parts.length > 0 ? `## How you work (always)\n\n${parts.join('\n\n')}${reinforcement}` : '';

  const roleBlock =
    opts.role === 'orchestrator'
      ? surface === 'chat'
        ? DELEGATION_DISCIPLINE_BLOCK_CHAT
        : DELEGATION_DISCIPLINE_BLOCK
      : surface === 'chat'
        ? WORKER_DISCOVERY_BLOCK_CHAT
        : WORKER_DISCOVERY_BLOCK;

  // Le chat n'a pas `save_memory` : la discipline qui l'ordonne n'y va pas.
  const memoryBlock = surface === 'chat' ? '' : MEMORY_DISCIPLINE_BLOCK;
  return [catalogBlock, memoryBlock, roleBlock].filter(Boolean).join('\n\n');
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
  /**
   * Messaging channels this agent is ALREADY bound to, by slug. The rest of
   * `CHANNELS` is what it can be given, and saying so is the whole point: the
   * agent that answered "Telegram is not supported" (2026-09-21) was bound to
   * none of them and had never been told any existed.
   *
   * Omitted rather than defaulted to empty on purpose — a caller that does not
   * know the bindings would otherwise offer the owner a channel they have
   * already set up, which is the exact failure the three-state connector logic
   * below exists to avoid.
   */
  boundChannelSlugs?: string[];
  /**
   * Canaux qui ont une LIAISON, active ou non. Surensemble de
   * `boundChannelSlugs` : une liaison désactivée porte quand même son jeton, et
   * proposer de « configurer Telegram » à quelqu'un qui l'a déjà collé est
   * exactement ce que l'en-tête de ce bloc interdit (revue de la PR #329,
   * constat 1).
   *
   * Pourquoi ces canaux-là sont TUS plutôt que décrits : `enabled: false` n'est
   * produit par aucun écran (`grep -rn "enabled: false"` ne trouve, hors tests,
   * que du manifeste Slack et un réglage OpenRouter ; se déconnecter SUPPRIME
   * la ligne, `disconnectAgentChannelAction`), et l'onglet Channels rend une
   * telle liaison comme `disconnected`. Lui écrire une phrase reviendrait à
   * envoyer le propriétaire vers un interrupteur qui n'existe pas — la classe
   * d'erreur que la PR précédente vient de corriger dans le guide Telegram.
   * Omis = inconnu, et un inconnu ne vaut jamais une proposition.
   */
  configuredChannelSlugs?: string[];
  /**
   * False sur une surface sans les builtins de Nodal. Ce que le bloc ANNONCE —
   * « ceci est configuré chez toi, il suffit de te l'attacher » — reste : c'est
   * le fait qui évite un « je ne peux pas » devant une capacité qui existe. Le
   * GESTE (`attach_connector` / `attach_mcp`) part, parce que l'agent ne peut
   * pas le poser d'ici (revue Codex de la dette de la PR #73, passe 3,
   * constat 1).
   */
  nodalTools?: boolean;
}

/**
 * Layer 2bis — advertise what the agent COULD do but doesn't have yet, with the
 * THREE distinct states so it never tells the user to set up something that is
 * already there:
 *   - already configured in the workspace but not attached to this agent →
 *     "it's set up — just needs to be assigned to you" (NO new key required);
 *   - a capability with no connector configured at all → "needs <setup>";
 *   - capability skills not assigned → can be assigned.
 *
 * It also names two whole families the prompt used to be silent about, and that
 * silence is what produced the 2026-09-21 incident: MESSAGING CHANNELS and
 * AUTOMATIONS. An agent asked whether Telegram could be set up answered that it
 * was not supported, because nothing in its prompt had ever said the word.
 * Both lists are read from the product's own registries — `CHANNELS`, which is
 * the source of the `channel_bindings` CHECK constraint, and `AUTOMATION_KINDS`,
 * which names the two tables a trigger lives in — never from a table written
 * here by hand.
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

  // Channels with no binding at all. Omitted bindings mean "unknown", and an
  // unknown binding must not become an offer to set up what is already set up.
  // A channel that HAS a binding is simply not offered, whether or not that
  // binding is enabled (see `configuredChannelSlugs`).
  const configured = input.configuredChannelSlugs ?? input.boundChannelSlugs;
  const freeChannels =
    input.boundChannelSlugs === undefined
      ? []
      : CHANNELS.filter((c) => configured?.includes(c) !== true);

  // No early return any more. It used to fire when an agent already had every
  // skill and connector, and the block vanished — which was right while the
  // block only listed things an agent can RUN OUT OF. Automations are not like
  // that: any agent can be put on a schedule at any time, so there is no state
  // in which naming them is wrong, and an agent that has never heard of them
  // answers "I cannot run on a schedule" to a question with a screen behind it.
  // The cost is about seventy tokens on a prompt that is cached across an
  // agent's jobs.
  // L'en-tête ne dit plus ce qu'est chaque famille : il ne pouvait pas. Il
  // disait « ceci n'est pas actif pour toi », ce qui est faux d'une
  // automatisation — elle n'est à personne, le propriétaire la crée quand il
  // veut (revue de la PR #329, constat 2). Chaque section porte donc sa propre
  // phrase, et l'en-tête ne garde que ce qui vaut pour toutes : ne fais pas
  // semblant, ne refuse pas sec, ne fais pas reconfigurer ce qui existe.
  const lines: string[] = [
    '## Capabilities you can request',
    '',
    'What this workspace can do for you, beyond what is wired to you right now. Read ' +
      'the section that fits before you answer — do NOT pretend you already can, do NOT ' +
      'refuse flatly, and do NOT ask the user to set up something that is already there.',
  ];

  if (skills.length > 0) {
    lines.push('', 'Skills you can ask to be assigned:');
    for (const s of skills) lines.push(`- \`${s.slug}\` — ${s.description}`);
  }

  if (readyConnectors.length > 0 || readyMcps.length > 0) {
    lines.push(
      '',
      input.nodalTools === false
        ? 'ALREADY configured in this workspace — just needs to be assigned to you ' +
            '(NO new API key needed; say so, and the job you hand the task to can do the ' +
            'attaching):'
        : 'ALREADY configured in this workspace — just needs to be assigned to you ' +
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

  if (freeChannels.length > 0) {
    lines.push(
      '',
      'Messaging channels you can be given. Each is a real feature of this product, ' +
        "set up per agent by the owner on the agent's settings, Channels tab:",
    );
    for (const channel of freeChannels) lines.push(`- \`${channel}\``);
  }

  // Automations are not "not yet active" the way a connector is — any agent can
  // be given one at any time — but they belong in the same block for the same
  // reason: an agent that has never heard of them answers "I cannot run on a
  // schedule" to a question the product has a screen for.
  lines.push(
    '',
    'Automations. You do not have to be asked in a message to run: the owner can start ' +
      'a job for you from either of these, and you can suggest one when a request is ' +
      'really a recurring need:',
  );
  for (const automation of AUTOMATION_KINDS) {
    lines.push(`- \`${automation.kind}\` — ${automation.summary}. Created in ${automation.where}.`);
  }

  return lines.join('\n');
}
