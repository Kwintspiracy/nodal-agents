// router/internal-tools.ts — the always-on built-in tools, described for the
// dashboard's per-tool controls.
//
// Why here and not in apps/web: the descriptions are DERIVED from the real tool
// definitions (`ALWAYS_ON_TOOL_DOCS`, itself built from each tool's own
// `description` field), so a tool whose wording changes cannot drift from what
// the owner reads before switching it off. apps/web already depends on this
// package and not on `@nodal-agents/tools`, which pulls in the Office document
// libraries — no reason to drag those into the dashboard for sixteen labels.
//
// Why this exists at all: the Autonomy screen only ever listed OUTWARD tools
// (connector operations, Telegram, MCP servers). The sixteen internal ones were
// always on and invisible, so an owner could not say "this agent may read files
// but never search the web" without reaching for the blunt read-only preset.

import { ALWAYS_ON_TOOLS, ALWAYS_ON_TOOL_DOCS, UNBLOCKABLE_TOOLS } from '@nodal-agents/tools';
import type { OperationDescriptor } from '@nodal-agents/shared';

/**
 * Human labels. The tool NAME is the identifier the model sees and the owner
 * may recognise from a transcript, so it stays visible in the UI — this is the
 * plain-language half, for someone who has never read a tool list.
 */
const LABELS: Readonly<Record<string, string>> = {
  return_result: 'Finish a task',
  ask_user: 'Ask the user a question',
  register_project: 'Create a project',
  skill_view: 'Read its own skills',
  list_models: 'List available models',
  list_schedules: 'List its schedules',
  save_memory: 'Remember a fact',
  query_memory: 'Recall a fact',
  search_history: 'Search past conversations',
  mark_memory_helpful: 'Mark a memory useful',
  mark_memory_outdated: 'Mark a memory outdated',
  web_search: 'Search the web',
  dashboard_publish: 'Publish to the dashboard',
  file_read: 'Read a workspace file',
  file_write: 'Write a workspace file',
  file_edit: 'Edit a workspace file',
  file_list: 'List workspace files',
  file_search: 'Search workspace files',
};

/**
 * Risk, in the same three-level vocabulary the connector operations use, so one
 * row reads the same wherever it appears. Anything that changes state on disk or
 * reaches outside the workspace is `write`; the rest is `read`.
 */
const RISK: Readonly<Record<string, OperationDescriptor['risk']>> = {
  register_project: 'write',
  save_memory: 'write',
  mark_memory_helpful: 'write',
  mark_memory_outdated: 'write',
  web_search: 'write',
  dashboard_publish: 'write',
  file_write: 'write',
  file_edit: 'write',
};

/**
 * Re-exported so the dashboard can refuse a blocking rule server-side without
 * taking a dependency on `@nodal-agents/tools`. Same object, one source.
 */
export { UNBLOCKABLE_TOOLS };

export type InternalToolDescriptor = OperationDescriptor & {
  /** Set when the tool may not be blocked; the string says why, verbatim to the owner. */
  unblockableReason?: string;
};

/**
 * The always-on tools, in the order the runtime grants them.
 *
 * `return_result` is included rather than hidden: an owner who counts the tools
 * in the docs and finds one fewer here would reasonably wonder what the
 * product is not telling them. It carries `unblockableReason` instead, and the
 * UI renders it locked.
 */
export const INTERNAL_TOOL_DESCRIPTORS: readonly InternalToolDescriptor[] = ALWAYS_ON_TOOLS.map(
  (name): InternalToolDescriptor => {
    const doc = ALWAYS_ON_TOOL_DOCS.find((d) => d.name === name);
    const reason = UNBLOCKABLE_TOOLS[name];
    return {
      slug: name,
      name: LABELS[name] ?? name,
      risk: RISK[name] ?? 'read',
      // These are internal capabilities, not outward actions: none of them
      // ships an approval gate of its own. The owner can still add one.
      requiresApproval: false,
      ...(doc?.description === undefined ? {} : { description: doc.description }),
      ...(reason === undefined ? {} : { unblockableReason: reason }),
    };
  },
);
