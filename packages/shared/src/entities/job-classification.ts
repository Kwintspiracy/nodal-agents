// job-classification.ts — derive "chat" vs "task" from a job's tools_used,
// for the Jobs page grouping (migration 0059). Deliberately NOT a DB column:
// deriving it from tools_used means the label can never drift from what the
// job actually did.

/**
 * Tools whose sole purpose is DELIVERING a reply to the user on some channel,
 * or ending the job cleanly. A job that only ever called these (or called
 * none at all) is a plain back-and-forth exchange, not a unit of work.
 */
export const CHAT_DELIVERY_TOOLS = [
  'telegram_send_message',
  'send_image',
  'send_file',
  'send_video',
  'send_audio',
  'send_voice',
  'return_result',
  'dashboard_publish',
] as const;

/**
 * Always-on built-in tools (ALWAYS_ON_TOOLS in @nodal-agents/tools) that are
 * PURE READS of context the agent already has standing access to — memory,
 * episodic history, its own skill/model/schedule catalog, its own workspace
 * files. A chat that merely consults this context (e.g. "what did we talk
 * about yesterday?") is still a chat, not a task: nothing was done ON BEHALF
 * of the user, only recalled.
 *
 * Deliberately excludes the other always-on tools that WRITE or reach
 * outward — file_write, file_edit, save_memory, mark_memory_helpful,
 * mark_memory_outdated, web_search — those are task-shaped even though
 * they're always-on.
 */
export const CHAT_CONTEXT_READ_TOOLS = [
  'query_memory',
  'search_history',
  'skill_view',
  'list_models',
  'list_schedules',
  'file_read',
  'file_list',
  'file_search',
] as const;

const CHAT_ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  ...CHAT_DELIVERY_TOOLS,
  ...CHAT_CONTEXT_READ_TOOLS,
]);

export type JobKind = 'chat' | 'task';

/**
 * Classify a job as 'chat' or 'task' from its `tools_used` column.
 * - 'chat': tools_used is empty/null, or every tool it used is a
 *   delivery/terminal tool or a pure context-read always-on tool.
 * - 'task': it used at least one tool outside that set — run_command, any
 *   connector/adapter tool, create_task/assign_*, file writes, web_search,
 *   memory writes, etc.
 */
export function classifyJob(toolsUsed: readonly string[] | null | undefined): JobKind {
  if (!toolsUsed || toolsUsed.length === 0) return 'chat';
  return toolsUsed.every((t) => CHAT_ALLOWED_TOOLS.has(t)) ? 'chat' : 'task';
}
