// agent-baseline.ts — the behavior layers every agent gets, beyond its
// personality and assigned skills. Three layers (see the plan):
//   1. BASELINE  — intrinsic discipline injected into EVERY agent's prompt
//      (verify-before-done, safe-tool-use, language-mirror). Content comes from
//      the catalog skills flagged `kind: 'baseline'` — universal, not assignable.
//      Its size is held by a budget (tests/baseline-budget.test.ts): it is
//      sent on every job of every agent.
//   2. CHANNEL   — gone (#613). It injected hand-written Telegram rules that
//      contradicted the runner; a channel's facts are now one line of the
//      `## Job context` block, built from the adapter (system-prompt.ts).
//   2bis. DISCOVERABILITY — the capability skills + connectors the agent does
//      NOT have yet, so it can offer them ("I can't search the web, but if you
//      add a Tavily key we can") instead of pretending or refusing flatly.
//
// Reading baseline content from the catalog (not the DB) is deliberate:
// these are universal, never user-edited, and the catalog is the code's source
// of truth — so the prompt can never drift from a stale seed.

import { systemSkills, skillKind, skillContentOn } from '@nodal-agents/catalog';
import type { PromptSurface } from '@nodal-agents/catalog';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { CHANNELS, AUTOMATION_KINDS } from '@nodal-agents/shared';
import { toolsNamedIn } from './router/tool-availability';

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
  kind: 'baseline',
  surface: PromptSurface = 'job',
  availableTools?: readonly string[],
): string[] =>
  systemSkills
    .filter((s) => skillKind(s) === kind)
    .filter((s) => hasRequiredBuiltins(s, availableTools))
    .map((s) => skillContentOn(s, surface))
    .filter((text): text is string => text !== null)
    .filter((text) => namesOnlyHeldTools(text, availableTools));

/**
 * Le prompt ne nomme jamais un outil que le job n'a pas (#559).
 *
 * `requiredBuiltins` ne couvre que ce qu'une skill DÉCLARE ; le texte, lui,
 * nomme ce qu'il veut, et rien ne vérifiait l'accord des deux. La skill
 * Telegram ne déclarait rien et ordonnait `telegram_send_message` : un
 * Researcher délégué, qui héritait du `chat_id` de son parent sans en avoir
 * l'outil, a obéi au prompt et a été tué pour `whitelist_violation`. Lire les
 * noms dans le texte même rend l'oubli impossible, pour toute skill de socle
 * ou de canal, sur toute surface.
 *
 * Liste inconnue : rien n'est retiré par ce filtre, `hasRequiredBuiltins`
 * reste fermé comme avant. Le prompt d'un job passe toujours sa liste
 * (`buildSystemPrompt`).
 */
const namesOnlyHeldTools = (text: string, availableTools?: readonly string[]): boolean =>
  availableTools === undefined || toolsNamedIn(text).every((t) => availableTools.includes(t));

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

A memory fact that proves false in practice (a missing path, an invalid ID, a failing procedure) is corrected, never silently reused: call \`mark_memory_outdated\` with the reason, then \`save_memory\` the verified fact. Save only what is verified and durable (a path, an ID, a stated preference, a procedure that worked). Never save a rule for another agent or a discovery ban ("don't search for X"), and never a log of what you did: the file, the message and the run are their own record. A routine's record of its last run is its routine state.`;
// « routine state » sans le nom de l'outil (#559) : `save_routine_state` n'est
// armé que pour un job de routine, et c'est le bloc `## Runtime` de ce job-là
// qui le nomme (buildRuntimeBlock, état de routine).

// « When a call has to be approved » n'existe plus (01/10/2026, lot 2) : il
// redisait ce que le modèle lit au moment où ça sert. Le champ `purpose` porte
// sa propre consigne dans le schéma de chaque outil (`PURPOSE_DESCRIPTION`,
// tools/src/purpose.ts), et un appel qui la manque revient non exécuté avec le
// geste exact qui répare (`missingPurposeInstruction`, même fichier).

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

/**
 * Layer 1 — intrinsic discipline, the same for every agent on a surface.
 *
 * No model parameter any more (01/10/2026, lot 2). A regex over the model name
 * (`NEEDS_FIRMER_VERIFY`: deepseek, minimax, qwen, glm…) used to append an
 * "Especially you — execution discipline" paragraph for some providers only
 * (5887686e, over-exploration seen on MiniMax and DeepSeek). Being decisive
 * with what you were given is true of every agent, so the rule now lives once
 * in the catalog (`safe-tool-use`, its "Be decisive" line), on every model:
 * one text, no per-provider branch (rule #11).
 */
export function buildBaselineBlock(
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
  // A coding-CLI session gets only what the catalog declares for it
  // (`surfaces: [..., 'cli-runtime']`): rules whose text names no Nodal tool.
  // Everything else stays off, for the reason above. The catalog decides, not
  // this function (invariant #3) — the first such rule is "a question about
  // Nodal is yours" (Codex review of #455, pass 3).
  if (!nodalTools) {
    const portable = contentOfKind('baseline', 'cli-runtime', opts.availableTools);
    return portable.length > 0 ? `## How you work (always)\n\n${portable.join('\n\n')}` : '';
  }
  const surface = opts.surface ?? 'job';
  const parts = contentOfKind('baseline', surface, opts.availableTools);
  const catalogBlock = parts.length > 0 ? `## How you work (always)\n\n${parts.join('\n\n')}` : '';

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
  /**
   * Les outils de ce job (#559). Le geste d'attacher ne nomme que ceux que le
   * job a : `attach_connector` / `attach_mcp` sont des outils du ROOT, et un
   * worker à qui on les nommait n'avait aucun moyen de les appeler. Omis =
   * inconnu : aucun outil nommé.
   */
  availableTools?: readonly string[];
}

/**
 * L'outil qui attache CHAQUE type de ressource. Un geste par type (revue Codex
 * de #570, passe 2) : un seul geste construit sur les outils détenus disait
 * « attach it yourself with attach_connector » devant un serveur MCP, un outil
 * détenu qui n'y peut rien.
 */
const ATTACH_TOOL = { connector: 'attach_connector', mcp: 'attach_mcp' } as const;

/** Comment une ressource déjà configurée arrive jusqu'à cet agent, dit avec SON outil. */
function attachGesture(kind: keyof typeof ATTACH_TOOL, availableTools?: readonly string[]): string {
  const tool = ATTACH_TOOL[kind];
  return availableTools?.includes(tool)
    ? `attach it with \`${tool}\`, or ask the user to`
    : 'ask the user to assign it to you';
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
  //
  // The gate is on `configured`, not on `boundChannelSlugs`. Either field on
  // its own is enough to answer the only question asked here — which channels
  // have no binding — and gating on the narrower one left a caller that knew
  // ALL the bindings unable to say anything (Reviewer C, pass 3, mutation B:
  // the most conservative gate was also the one that threw away the most).
  const configured = input.configuredChannelSlugs ?? input.boundChannelSlugs;
  const freeChannels =
    configured === undefined ? [] : CHANNELS.filter((c) => !configured.includes(c));

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
            '(NO new API key needed):',
    );
    // Sur une surface sans les builtins, le geste est dit une fois, plus haut.
    const gesture = (kind: keyof typeof ATTACH_TOOL): string =>
      input.nodalTools === false ? '' : `; ${attachGesture(kind, input.availableTools)}`;
    for (const c of readyConnectors)
      lines.push(
        `- ${labelForConnector(c.slug, c.name)} — connector \`${c.slug}\` (configured${gesture('connector')})`,
      );
    for (const m of readyMcps)
      lines.push(`- ${m.name} — MCP server \`${m.slug}\` (configured${gesture('mcp')})`);
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
