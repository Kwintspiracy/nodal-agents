// Built-in tools registration
// Call registerBuiltins(registry) once at startup to make all built-in tools available.

import type { ToolRegistry } from '../types';
import { returnResultTool } from './return-result';
import { askUserTool } from './ask-user';
import { registerProjectTool } from './register-project';
import { saveMemoryTool } from './save-memory';
import { queryMemoryTool } from './query-memory';
import { nodalDocsTool } from './nodal-docs';
import { searchHistoryTool } from './search-history';
import { markMemoryHelpfulTool } from './mark-memory-helpful';
import { markMemoryOutdatedTool } from './mark-memory-outdated';
import { webSearchTool } from './web-search';
import { dashboardPublishTool } from './dashboard-publish';
import {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  fileSearchTool,
} from './file-ops';
import { OFFICE_TOOLS } from './office-ops';
import { META_TOOLS } from './meta-ops';
import { SKILL_TOOLS, skillFileWriteTool } from './skill-ops';
import { runCommandTool } from './run-command';
import { codeTaskTool } from './code-task';
import { reviewVerdictTool } from './review-verdict';
import { runSkillScriptTool } from './run-skill-script';
import { saveRoutineStateTool } from './save-routine-state';
import { declareVerificationTool } from './declare-verification';
import { skillViewTool } from './skill-view';
import { listModelsTool } from './list-models';
import { listSchedulesTool } from './list-schedules';

export { returnResultTool } from './return-result';
export { askUserTool, AskUserInputSchema } from './ask-user';
export { registerProjectTool, RegisterProjectInputSchema } from './register-project';
export type { RegisterProjectInput, RegisterProjectOutput } from './register-project';
export type { AskUserInput, AskUserOutput } from './ask-user';
export { skillViewTool } from './skill-view';
export { listModelsTool } from './list-models';
export { listSchedulesTool } from './list-schedules';
// list_conversations — capability-driven like the communication send tools
// (NOT registered via registerBuiltins/ALWAYS_ON_TOOLS): the runner
// instantiates it directly and pushes it into capabilityTools only when the
// agent has ≥1 enabled channel binding, mirroring the 6 send tools' gate.
export { createListConversationsTool } from './list-conversations';
export { saveMemoryTool } from './save-memory';
export { queryMemoryTool } from './query-memory';
export { nodalDocsTool, NodalDocsInputSchema } from './nodal-docs';
export {
  loadDocsIndex,
  searchDocs,
  resetDocsIndexCache,
  docsIndexCandidatePaths,
  DocsIndexUnavailableError,
} from './docs-index';
export type { DocsIndex, DocsSection, DocsHit } from './docs-index';
export { searchHistoryTool } from './search-history';
export { markMemoryHelpfulTool } from './mark-memory-helpful';
export { markMemoryOutdatedTool } from './mark-memory-outdated';
export { webSearchTool } from './web-search';
export { dashboardPublishTool, DashboardPublishInputSchema } from './dashboard-publish';
export type { DashboardPublishInput } from './dashboard-publish';
export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  fileSearchTool,
  WorkspaceError,
} from './file-ops';
export { OFFICE_TOOLS } from './office-ops';
export { META_TOOLS } from './meta-ops';
export {
  createSkillTool,
  assignSkillTool,
  createAgentTool,
  updateAgentTool,
  attachAgentTool,
} from './meta-ops';
export {
  SKILL_TOOLS,
  skillFileReadTool,
  skillFileListTool,
  skillFileWriteTool,
  SkillFileError,
} from './skill-ops';
export { runCommandTool } from './run-command';
export { assertCommandAllowed, CommandNotAllowedError } from './command-allowlist';
export type { RunCommandInput, RunCommandOutput } from './run-command';
export { codeTaskTool, runCliDoctor } from './code-task';
export type { CodeTaskInput, CodeTaskOutput, CliDoctorReport } from './code-task';
// CLI plumbing reused by the runner's runtime-agent path (étape E) and by
// adapters that spawn an official CLI (adapter-cloudflare → wrangler).
export {
  resolveCliPath,
  buildSpawnArgv,
  runCli,
  // L'UNIQUE constructeur d'argv Codex, et l'UNIQUE lecteur de ses événements
  // d'outils : le runtime Codex (apps/runner/src/cli-runtime/codex-turn.ts) les
  // emprunte au lieu d'en écrire une deuxième version, qui aurait dérivé.
  buildProviderArgs,
  parseLiveToolEvent,
  extractClaudeUsage,
  extractClaudeModelUsage,
  CLAUDE_READONLY_DISALLOWED,
  assertCliBudget,
  recordCliRun,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  WorkspaceLockedError,
  workspaceLockKey,
  assertRuntimeSessionKey,
  CODE_TASK_KEY_PREFIX,
} from './code-task';
export type { NormalizedCliResult } from './code-task';
// Workspace confinement, reused by adapters that touch workspace files
// (adapter-cloudflare deploys a built directory) — ONE resolution/escape
// check implementation, never a per-adapter copy.
export { assertWorkspacesConfigured, resolveAndCheckPath } from './file-ops/workspace';
export { reviewVerdictTool } from './review-verdict';
export type { ReviewVerdictInput, ReviewVerdictOutput } from './review-verdict';
export { runSkillScriptTool } from './run-skill-script';
export { saveRoutineStateTool } from './save-routine-state';
export { declareVerificationTool } from './declare-verification';
export type { SaveRoutineStateInput, SaveRoutineStateOutput } from './save-routine-state';
export type { RunSkillScriptInput, RunSkillScriptOutput } from './run-skill-script';
export { buildChildEnv, safeEnvAllowlistSnapshot } from './child-env';
export {
  runShellCommand,
  runCommandSequence,
  killProcessTree,
  isGreen,
  SHELL_POLICY_VERSION,
  DEFAULT_MAX_OUTPUT_CHARS,
} from './shell-engine';
export type {
  CommandOutcome,
  CommandRunResult,
  CommandSpec,
  CommandTarget,
  SequenceResult,
  SequenceStepResult,
  SequenceOptions,
} from './shell-engine';

/**
 * Register all built-in tools into the given registry.
 * Idempotent — calling twice just overwrites with the same tools.
 *
 * Office tools (xlsx_*, docx_*, pptx_*) are registered here but NOT added to
 * ALWAYS_ON_TOOLS — they are gated behind the "office-editing" skill via the
 * skill's requiredBuiltins field. The runner unions each assigned skill's
 * requiredBuiltins into the whitelist alongside alwaysOn.
 */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(returnResultTool);
  registry.register(askUserTool);
  registry.register(registerProjectTool);
  registry.register(skillViewTool);
  registry.register(listModelsTool);
  registry.register(listSchedulesTool);
  registry.register(saveMemoryTool);
  registry.register(queryMemoryTool);
  registry.register(nodalDocsTool);
  registry.register(searchHistoryTool);
  registry.register(markMemoryHelpfulTool);
  registry.register(markMemoryOutdatedTool);
  registry.register(webSearchTool);
  registry.register(dashboardPublishTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(fileListTool);
  registry.register(fileSearchTool);
  // Office tools — gated behind the "office-editing" skill, NOT always-on.
  for (const tool of OFFICE_TOOLS) {
    registry.register(tool);
  }
  // Meta-tools (create_agent, create_skill, attach_skill) — gated behind the
  // root agent designation + per-grant toggles in rootGrants. NOT always-on.
  // The runner unions these into alwaysOn only for the entity's root agent.
  for (const tool of META_TOOLS) {
    registry.register(tool);
  }
  // Skill-file tools (skill_file_read, skill_file_list) — gated behind an
  // installed community skill's requiredBuiltins, NOT always-on. The runner
  // unions each assigned skill's requiredBuiltins into the whitelist.
  for (const tool of SKILL_TOOLS) {
    registry.register(tool);
  }
  // run_command — gated behind the "command-execution" skill via requiredBuiltins,
  // NOT always-on. Safe-by-default (defaultApproval='require_approval'); a
  // per-agent auto_approve rule ("Yolo") overrides the human-in-the-loop gate.
  registry.register(runCommandTool);
  // code_task — gated behind the "code-task" skill via requiredBuiltins, NOT
  // always-on. Safe-by-default like run_command (defaultApproval
  // 'require_approval'; per-agent Yolo rule overrides; LAN master-switch
  // neutralizes Yolo outside local-trust — see CODE_EXECUTION_TOOLS in the
  // runner). Spawns the owner's own coding CLI (claude/codex) under their
  // subscription.
  registry.register(codeTaskTool);
  // review_verdict — gated behind the "code-review" skill via requiredBuiltins,
  // NOT always-on. Pure validation/normalization of a structured review
  // verdict (étape C) — writes nothing, riskLevel 'read'.
  registry.register(reviewVerdictTool);
  // run_skill_script — gated by per-skill×agent script authorization
  // (agent_skill_assignments.scripts_authorized), NOT always-on and NOT via
  // requiredBuiltins. The runner adds it to the whitelist only when the agent
  // has ≥1 authorized script-skill. Safe-by-default like run_command.
  registry.register(runSkillScriptTool);
  // skill_file_write — gated by per-skill×agent file-write authorization
  // (agent_skill_assignments.files_writable), NOT always-on and NOT via
  // requiredBuiltins. The runner adds it to the whitelist only when the agent
  // has ≥1 file-writable skill. Safe-by-default like run_skill_script.
  registry.register(skillFileWriteTool);
  // save_routine_state — offert UNIQUEMENT aux jobs déclenchés par une routine
  // (`agent_jobs.schedule_id`). Porté ici au registre, ajouté à la whitelist par
  // le runner. Un agent qui n'a pas de routine ne le voit pas dans son prompt.
  registry.register(saveRoutineStateTool);
  // declare_verification — offert avec les outils d'écriture de fichiers : un
  // agent qui produit doit pouvoir dire comment on vérifie ce qu'il a produit.
  registry.register(declareVerificationTool);
}

/**
 * Names of the always-on built-in tools.
 * Pass these as alwaysOn to computeToolWhitelist().
 */
export const ALWAYS_ON_TOOLS = [
  'return_result',
  // ask_user — TOUJOURS disponible, sans skill ni toggle. C'est la leçon de
  // l'incident de confabulation (11-12/07) : un agent qui ne peut pas demander
  // invente. Le rendre optionnel reviendrait à laisser un agent sans ce recours
  // par simple oubli de configuration, et ce qu'il produirait alors serait
  // indiscernable d'une réponse fondée.
  'ask_user',
  // register_project — TOUJOURS disponible, pour la même raison qu'`ask_user` :
  // c'est la seconde moitié d'un seul geste (P10b). Un agent qui peut demander
  // « où ranger ce rapport ? » mais pas créer le projet que l'utilisateur vient
  // de choisir n'aurait plus qu'à écrire quelque part au hasard.
  'register_project',
  // declare_verification — la seconde moitié de « produire » : un agent qui
  // écrit doit pouvoir dire comment on vérifie ce qu'il a écrit. Optionnel, il
  // ne serait jamais là quand il faut — et la vérification système n'a jamais
  // tourné une seule fois tant qu'elle a dépendu d'une saisie du propriétaire.
  'declare_verification',
  'skill_view',
  'list_models',
  'list_schedules',
  'save_memory',
  'query_memory',
  // nodal_docs — TOUJOURS disponible, comme `ask_user`, et pour la même raison :
  // un agent qui ne peut pas consulter le manuel de la plateforme dans laquelle
  // il tourne invente ce qu'elle sait faire. Le 21/09, le root agent a répondu
  // que Telegram n'était pas supporté et a proposé de construire un serveur MCP.
  // Le gating par skill (`requiredBuiltins`) n'est PAS une option ici : la
  // branche orchestrateur d'`executeJob` ne lit pas `requiredBuiltins`, donc
  // l'outil n'aurait jamais atteint l'agent ROOT, qui est précisément celui à
  // qui l'on parle.
  'nodal_docs',
  'search_history',
  'mark_memory_helpful',
  'mark_memory_outdated',
  'web_search',
  'dashboard_publish',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_search',
] as const;
export type AlwaysOnTool = (typeof ALWAYS_ON_TOOLS)[number];

/**
 * Always-on tools an owner may NOT block, with the reason stated per tool.
 *
 * Every other always-on tool is a capability: switching it off narrows what the
 * agent can do, which is the owner's call. `return_result` is not a capability
 * — it is the state-machine signal that ENDS a job. Blocking it does not make
 * the agent do less; it makes every one of its jobs unable to finish, and the
 * agent has no way to report that, since reporting is the very tool it just
 * lost. That is not a restriction, it is a trap.
 *
 * Enforced server-side (setAgentApprovalRuleAction), not only in the UI: a
 * dashboard-only guard is one API call away from being bypassed. Fails loud
 * (invariant #4) rather than silently ignoring the rule.
 */
export const UNBLOCKABLE_TOOLS: Readonly<Record<string, string>> = {
  return_result:
    'return_result is how a job reports that it finished or is stuck. Blocking it would leave ' +
    'every job of this agent unable to end, with no way to tell you why.',
};

/**
 * Documentation for the always-on built-in tools.
 * Source of truth for the "Built-in capabilities" block injected into every
 * agent's system prompt by buildSystemPrompt() in @nodal-agents/orchestration.
 *
 * Order matches ALWAYS_ON_TOOLS. Adding a new always-on tool requires updating
 * BOTH this array and ALWAYS_ON_TOOLS — keep them in sync. The `{name, description}`
 * shape is data-driven from the underlying tool definitions, so the prompt block
 * always reflects the canonical tool docs.
 */
export const ALWAYS_ON_TOOL_DOCS: ReadonlyArray<{ name: string; description: string }> = [
  { name: returnResultTool.name, description: returnResultTool.description },
  { name: askUserTool.name, description: askUserTool.description },
  { name: registerProjectTool.name, description: registerProjectTool.description },
  { name: declareVerificationTool.name, description: declareVerificationTool.description },
  { name: skillViewTool.name, description: skillViewTool.description },
  { name: listModelsTool.name, description: listModelsTool.description },
  { name: listSchedulesTool.name, description: listSchedulesTool.description },
  { name: saveMemoryTool.name, description: saveMemoryTool.description },
  { name: queryMemoryTool.name, description: queryMemoryTool.description },
  { name: nodalDocsTool.name, description: nodalDocsTool.description },
  { name: searchHistoryTool.name, description: searchHistoryTool.description },
  { name: markMemoryHelpfulTool.name, description: markMemoryHelpfulTool.description },
  { name: markMemoryOutdatedTool.name, description: markMemoryOutdatedTool.description },
  { name: webSearchTool.name, description: webSearchTool.description },
  { name: dashboardPublishTool.name, description: dashboardPublishTool.description },
  { name: fileReadTool.name, description: fileReadTool.description },
  { name: fileWriteTool.name, description: fileWriteTool.description },
  { name: fileEditTool.name, description: fileEditTool.description },
  { name: fileListTool.name, description: fileListTool.description },
  { name: fileSearchTool.name, description: fileSearchTool.description },
];
