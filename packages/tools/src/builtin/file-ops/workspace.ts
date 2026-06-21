// file-ops/workspace.ts — multi-workspace path resolution + security
//
// Three non-negotiable guarantees (unchanged from single-root version):
//   1. Every resolved path stays under the selected workspace root, even when
//      the caller passes ../../, even when symlinks point outside.
//      fs.realpath is applied after lexical resolution so symlink-escape
//      attempts are caught at the resolution layer.
//   2. Workspace list comes from the agent row. When the list is empty or
//      unset, file tools fail loud — they MUST NOT silently default to cwd
//      or $HOME.
//   3. Absolute paths passed by the LLM must resolve INSIDE exactly one
//      known workspace root; anything else is path_traversal_blocked.

import { realpath, stat } from 'node:fs/promises';
import { resolve as resolvePath, sep, isAbsolute, basename } from 'node:path';
import type { ToolContext } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Label of the auto-injected, entity-wide SHARED workspace (a common scratch /
 * hand-off area for all agents in the entity). It is ADDITIVE: reachable via the
 * "shared/" label but never the implicit default and never forces a label on
 * agents that have one real workspace. The runner injects it under this label.
 */
export const SHARED_WORKSPACE_LABEL = 'shared';

/**
 * Max bytes returned by a single file_read call. Larger files require explicit
 * offset/limit pagination. 1 MiB ≈ ~250k tokens at 4 chars/token — already at
 * the upper edge of what most context windows want to receive in one shot.
 */
export const MAX_READ_BYTES = 1024 * 1024;

/**
 * Max bytes accepted by a single file_write call. Generative-AI workflows
 * don't realistically produce >1 MiB single-file outputs; capping prevents a
 * runaway loop from filling the disk.
 */
export const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * Max bytes scanned per file by file_search content matching. Files larger
 * than this are skipped (their names still match filename-only searches).
 */
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WorkspaceError extends Error {
  readonly code:
    | 'workspace_not_configured'
    | 'path_traversal_blocked'
    | 'workspace_invalid'
    | 'workspace_label_required'
    | 'workspace_label_unknown';
  constructor(
    code:
      | 'workspace_not_configured'
      | 'path_traversal_blocked'
      | 'workspace_invalid'
      | 'workspace_label_required'
      | 'workspace_label_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

// ─── assertWorkspacesConfigured ───────────────────────────────────────────────

/**
 * Guard: fail loud when the agent has no workspaces configured.
 * Returns the validated workspace list for downstream resolution.
 *
 * Throws WorkspaceError before any filesystem access — agents can read this
 * error and prompt the user to configure workspaces via the dashboard
 * (`/agents/<id>/edit` → Knowledge tab → Workspaces).
 *
 * Each workspace's path must be absolute (otherwise: workspace_invalid).
 */
export function assertWorkspacesConfigured(
  ctx: ToolContext,
): Array<{ label: string; path: string }> {
  const list = ctx.workspaces;
  if (!list || list.length === 0) {
    throw new WorkspaceError(
      'workspace_not_configured',
      'This agent has no workspace configured. Ask the user to add a workspace ' +
        '(Dashboard → Agents → Edit → Knowledge → Workspaces).',
    );
  }
  for (const ws of list) {
    if (!isAbsolute(ws.path)) {
      throw new WorkspaceError(
        'workspace_invalid',
        `Workspace "${ws.label}" has a non-absolute path: "${ws.path}". All workspace paths must be absolute.`,
      );
    }
  }
  return list;
}

// ─── resolveAndCheckPath ──────────────────────────────────────────────────────

/**
 * Resolve a user-requested path against the agent's workspace(s) and verify
 * it doesn't escape via `..` or symlinks. Returns the canonical absolute path
 * safe to pass to fs operations.
 *
 * Root-selection algorithm:
 *
 *   Relative path
 *   └─ Extract first segment:
 *      ├─ Matches a workspace label → use that workspace, remainder = path after label
 *      └─ No match:
 *         ├─ Exactly 1 workspace → use it, full requestedPath is the relative path
 *         └─ >1 workspaces → throw workspace_label_required (lists valid labels)
 *
 *   Absolute path
 *   └─ Try each workspace root in turn; realpath+boundary-check against each.
 *      First workspace that contains the absolute path is used.
 *      If none contain it → throw path_traversal_blocked.
 *
 * Boundary check per selected root (UNCHANGED from single-root version):
 *   1. realpath the root directory — throws workspace_invalid if missing.
 *   2. Lexically join requestedPath under realRoot (if relative) or use as-is.
 *   3. Walk up to find the deepest EXISTING ancestor (handles not-yet-created
 *      paths for file_write) and realpath that ancestor.
 *   4. Reconstruct canonical = realprobed-ancestor + non-existent suffix.
 *   5. Assert canonical === realRoot || canonical.startsWith(realRoot + sep).
 *      Symlink-escape is caught here: the apparent path is inside the workspace
 *      but realpath of the link target reveals the escape.
 */
export async function resolveAndCheckPath(
  ctx: ToolContext,
  requestedPath: string,
): Promise<string> {
  const workspaces = assertWorkspacesConfigured(ctx);

  if (isAbsolute(requestedPath)) {
    // Absolute path: try each workspace. First containing one wins.
    for (const ws of workspaces) {
      try {
        const resolved = await resolveUnderRoot(ws.path, requestedPath);
        return resolved;
      } catch (err) {
        if (err instanceof WorkspaceError && err.code === 'path_traversal_blocked') {
          continue; // not in this workspace, try the next
        }
        throw err;
      }
    }
    throw new WorkspaceError(
      'path_traversal_blocked',
      `Absolute path "${requestedPath}" does not reside in any configured workspace.`,
    );
  }

  // Relative path: split off the first segment to match a workspace label.
  // Normalise both slash styles so "notes\\file.md" works on Windows.
  const normalised = requestedPath.replace(/\\/g, '/');
  const slashIdx = normalised.indexOf('/');
  const firstSegment = slashIdx === -1 ? normalised : normalised.slice(0, slashIdx);
  const afterFirstSegment = slashIdx === -1 ? '' : normalised.slice(slashIdx + 1);

  const matchedWorkspace = workspaces.find((ws) => ws.label === firstSegment);

  if (matchedWorkspace) {
    // "notes/a.md" → workspace label "notes", relative "a.md"
    // "notes" (bare) → workspace label "notes", relative "" → resolves to root of that workspace
    const relativeInWorkspace = afterFirstSegment || '.';
    return resolveUnderRoot(matchedWorkspace.path, relativeInWorkspace);
  }

  // The auto-injected entity-wide SHARED workspace is ADDITIVE: it's reachable
  // by its "shared/" label, but it must never become the implicit default nor
  // force a label on agents that have exactly one real workspace. So the
  // default-resolution counts only NON-shared workspaces.
  const ownWorkspaces = workspaces.filter((ws) => ws.label !== SHARED_WORKSPACE_LABEL);

  if (ownWorkspaces.length === 1) {
    // Single real workspace: label prefix is optional — full path resolves under it.
    return resolveUnderRoot(ownWorkspaces[0]!.path, requestedPath);
  }
  if (ownWorkspaces.length === 0 && workspaces.length >= 1) {
    // Only the shared workspace exists — use it as the default.
    return resolveUnderRoot(workspaces[0]!.path, requestedPath);
  }

  // Multiple real workspaces, no matching label → fail loud listing valid labels.
  const validLabels = workspaces.map((ws) => ws.label).join(', ');
  throw new WorkspaceError(
    'workspace_label_required',
    `This agent has multiple workspaces. Prefix the path with a workspace label. ` +
      `Valid labels: ${validLabels}. Example: "${ownWorkspaces[0]!.label}/${requestedPath}".`,
  );
}

// ─── resolveUnderRoot (private) ──────────────────────────────────────────────

/**
 * Core boundary-check against a single workspace root. IDENTICAL security
 * logic to the former single-root resolveAndCheckPath — only extracted into
 * a helper so the multi-root dispatcher above can call it per candidate root.
 *
 * Two passes, both required:
 *   1. lexical join + resolve under workspace root — catches simple `..` escapes
 *      and rejects absolute paths outside the workspace.
 *   2. fs.realpath() on the resolved path — catches symlinks pointing outside
 *      the workspace (the apparent path is inside, but realpath reveals the
 *      escape). Falls back to the lexical resolution when the target doesn't
 *      exist yet (file_write creating a new file) — in that case we still
 *      realpath the PARENT to be safe.
 */
async function resolveUnderRoot(workspaceRoot: string, requestedPath: string): Promise<string> {
  const realRoot = await realpath(workspaceRoot).catch(() => {
    throw new WorkspaceError(
      'workspace_invalid',
      `Workspace root does not exist or is unreadable: "${workspaceRoot}".`,
    );
  });

  // Lexical resolution. If requestedPath is absolute, resolve() returns it
  // as-is; if relative, it is joined under realRoot. The boundary check below
  // catches the absolute-outside case.
  const lexical = isAbsolute(requestedPath)
    ? resolvePath(requestedPath)
    : resolvePath(realRoot, requestedPath);

  // Walk up to find the deepest existing ancestor of the lexical path, then
  // realpath() that. This lets us validate paths whose intermediate directories
  // don't exist yet (e.g. file_write with create_dirs:true creating
  // `nested/dir/new.txt` from scratch) while still catching symlink escapes on
  // any segment that DOES exist on disk.
  let probe = lexical;
  while (true) {
    try {
      await stat(probe);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkspaceError(
          'workspace_invalid',
          `Failed to stat path while resolving "${requestedPath}": ${(err as Error).message}`,
        );
      }
    }
    const parent = resolvePath(probe, '..');
    if (parent === probe) {
      // Reached filesystem root without finding anything — should be impossible
      // because the workspace root itself exists (verified above via realpath).
      throw new WorkspaceError(
        'path_traversal_blocked',
        `Cannot resolve "${requestedPath}" — walked past the filesystem root.`,
      );
    }
    probe = parent;
  }
  const realProbe = await realpath(probe);
  const remainder = lexical.slice(probe.length);
  const canonical = realProbe + remainder;

  // Boundary check: canonical MUST start with realRoot + path separator
  // (or equal realRoot itself). Without the separator suffix, "/work" would
  // accidentally match "/workplace/secret".
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (canonical !== realRoot && !canonical.startsWith(rootWithSep)) {
    throw new WorkspaceError(
      'path_traversal_blocked',
      `Path "${requestedPath}" resolves to "${canonical}", outside the workspace "${realRoot}".`,
    );
  }

  return canonical;
}

// ─── Convenience: get first workspace root (for tools that need the root) ──────

/**
 * Return the first workspace's absolute path, or the path of the workspace
 * that a given relativeOrLabeledPath would resolve to.
 *
 * This is a SYNCHRONOUS helper that does NOT do realpath / boundary checks —
 * use it only for computing display values or relative paths (e.g. the
 * workspaceRoot used in `relative()` for file listing). Boundary security is
 * always enforced by resolveAndCheckPath.
 *
 * Multi-workspace: if relativeOrLabeledPath starts with a known label,
 * returns that workspace's path. Otherwise returns the first workspace's path.
 */
export function getWorkspaceRootForDisplay(
  ctx: ToolContext,
  relativeOrLabeledPath?: string,
): string | undefined {
  const list = ctx.workspaces;
  if (!list || list.length === 0) return undefined;

  if (relativeOrLabeledPath) {
    const normalised = relativeOrLabeledPath.replace(/\\/g, '/');
    const firstSegment = normalised.split('/')[0] ?? '';
    const matched = list.find((ws) => ws.label === firstSegment);
    if (matched) return matched.path;
  }
  return list[0]!.path;
}

// Keep `basename` in scope so other modules importing workspace.ts can use it
// without a direct path import (avoids duplicate imports in callers).
export { basename };
