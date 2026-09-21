// router/internal-tools.ts — the always-on built-in tools, described for the
// dashboard's per-tool controls.
//
// Why here and not in apps/web: the owner-facing texts are DERIVED from the
// real tool definitions (`ALWAYS_ON_TOOL_DOCS`, itself built from each tool's
// own `label` and `summary` fields), so a tool whose wording changes cannot
// drift from what the owner reads before switching it off. apps/web already
// depends on this package and not on `@nodal-agents/tools`, which pulls in the Office document
// libraries — no reason to drag those into the dashboard for its labels.
//
// Why this exists at all: the Autonomy screen only ever listed OUTWARD tools
// (connector operations, Telegram, MCP servers). The internal ones were
// always on and invisible, so an owner could not say "this agent may read files
// but never search the web" without reaching for the blunt read-only preset.

import { ALWAYS_ON_TOOLS, ALWAYS_ON_TOOL_DOCS, UNBLOCKABLE_TOOLS } from '@nodal-agents/tools';
import type { OperationDescriptor } from '@nodal-agents/shared';

/**
 * Risk, in the same three-level vocabulary the connector operations use, so one
 * row reads the same wherever it appears. Anything that changes state on disk or
 * reaches outside the workspace is `write`; the rest is `read`.
 */
const RISK: Readonly<Record<string, OperationDescriptor['risk']>> = {
  register_project: 'write',
  declare_verification: 'write',
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

/**
 * One built-in tool as the OWNER reads it.
 *
 * It carries no `description`, and that absence is the point (issue #382): the
 * `description` of a ToolDefinition is written for the MODEL, and the screen
 * used to show it verbatim — a wall of "do NOT" addressed to someone else. The
 * model text cannot reach the dashboard through this type at all any more.
 */
export type InternalToolDescriptor = {
  /** The tool name, shown as the technical identifier under the summary. */
  slug: string;
  /** Short imperative title, declared by the tool itself. */
  label: string;
  /** One or two sentences for the owner, declared by the tool itself. */
  summary: string;
  risk: OperationDescriptor['risk'];
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
    if (!doc) {
      // Fails loud (invariant #4) rather than showing the owner a row titled
      // with a tool name: a tool granted to every agent and described nowhere
      // is a capability nobody was offered a control for.
      throw new Error(
        `Always-on tool "${name}" has no entry in ALWAYS_ON_TOOL_DOCS: the Approvals tab ` +
          'would have no title and no summary for it.',
      );
    }
    const reason = UNBLOCKABLE_TOOLS[name];
    return {
      slug: name,
      label: doc.label,
      summary: doc.summary,
      risk: RISK[name] ?? 'read',
      ...(reason === undefined ? {} : { unblockableReason: reason }),
    };
  },
);
