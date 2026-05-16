// file-ops/workspace.ts — path resolution + security for file_* tools
//
// Two non-negotiable guarantees:
//   1. Every resolved path stays under the agent's configured workspace root,
//      even when the user passes ../../, even when symlinks point outside.
//      We call fs.realpath after resolving so symlink escape attempts are
//      caught at the resolution layer (not at read/write time).
//   2. Workspace is per-agent (agents.workspace_root_path). When unset,
//      file tools fail loud — they MUST NOT silently default to cwd or $HOME.

import { realpath, stat } from 'node:fs/promises';
import { resolve as resolvePath, sep, isAbsolute } from 'node:path';
import type { ToolContext } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

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
  readonly code: 'workspace_not_configured' | 'path_traversal_blocked' | 'workspace_invalid';
  constructor(
    code: 'workspace_not_configured' | 'path_traversal_blocked' | 'workspace_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Guard: fail loud when the agent has no workspace configured. Returns the
 * resolved (NOT realpath'd) workspace root for downstream resolution.
 *
 * Throws WorkspaceError before any filesystem access — agents can read this
 * error and prompt the user to configure a workspace via the dashboard
 * (`/agents/<id>` → workspace_root_path field).
 */
export function assertWorkspaceConfigured(ctx: ToolContext): string {
  const raw = ctx.workspaceRootPath;
  if (raw === undefined || raw === null || raw.trim() === '') {
    throw new WorkspaceError(
      'workspace_not_configured',
      'This agent has no workspace configured. Ask the user to set ' +
        '`workspace_root_path` on the agent (Dashboard → Agents → Edit → Workspace root path).',
    );
  }
  if (!isAbsolute(raw)) {
    throw new WorkspaceError(
      'workspace_invalid',
      `workspace_root_path must be an absolute path (got "${raw}").`,
    );
  }
  return raw;
}

/**
 * Resolve a user-requested path against the agent's workspace and verify it
 * doesn't escape via `..` or symlinks. Returns the canonical absolute path
 * safe to pass to fs operations.
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
export async function resolveAndCheckPath(ctx: ToolContext, requestedPath: string): Promise<string> {
  const workspaceRoot = assertWorkspaceConfigured(ctx);
  const realRoot = await realpath(workspaceRoot).catch(() => {
    throw new WorkspaceError(
      'workspace_invalid',
      `workspace_root_path does not exist or is unreadable: "${workspaceRoot}".`,
    );
  });

  // Lexical resolution. If requestedPath is absolute, resolve() returns it
  // as-is; if relative, joined under realRoot. The boundary check below
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
      // because the workspace root itself exists (verified at line ~80).
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
