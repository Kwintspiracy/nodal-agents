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

import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import {
  resolve as resolvePath,
  relative as relativePath,
  sep,
  isAbsolute,
  dirname,
} from 'node:path';
import type { ToolContext } from '../../types';
import { cheminConstate, currentContentWrittenByJob } from '../../verification/record-constat';

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
 * Absolute hard cap on any single file_read / skill_file_read call, no matter
 * whether offset/limit is provided. Below MAX_READ_BYTES a file is read whole
 * via readFile(); between MAX_READ_BYTES and this cap it is read through a
 * bounded-memory streaming line reader (see file-ops/read-lines.ts) instead of
 * ever materializing the whole file as a single string. Above this cap the
 * call is refused outright — even with offset/limit — because there is no
 * safe way to serve a single line-window request without knowing where line
 * boundaries fall, which still requires scanning the whole file once. 50 MiB
 * bounds that scan cost and guarantees no read tool can be used to OOM the
 * runner regardless of how the caller paginates.
 */
export const MAX_READ_FILE_BYTES = 50 * 1024 * 1024;

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
    | 'workspace_label_unknown'
    | 'shared_file_changed';
  constructor(
    code:
      | 'workspace_not_configured'
      | 'path_traversal_blocked'
      | 'workspace_invalid'
      | 'workspace_label_required'
      | 'workspace_label_unknown'
      | 'shared_file_changed',
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
  ctx: Pick<ToolContext, 'workspaces'>,
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
  ctx: Pick<ToolContext, 'workspaces'>,
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

// ─── processAddressing ────────────────────────────────────────────────────────

/**
 * The sentence every tool that starts a process adds to its description (#592).
 * One wording, so the model reads the same rule wherever it can start one.
 */
export const PROCESS_PATHS_RULE =
  'Workspace labels are NOT folders for a process: the file tools address a file as ' +
  '"<label>/<path>", but a process resolves its paths against its own working directory, ' +
  "or takes absolute paths. The result's `paths` says where the process ran and what a " +
  'file-tool path is called there; reach another workspace by its absolute path (also in `paths`).';

/** `child` is `root` itself or a folder under it (case-insensitive on Windows). */
function isWithin(root: string, child: string): boolean {
  const rel = relativeWithin(root, child);
  return rel !== null;
}

/**
 * `child` relative to `root` with forward slashes (`''` when they are the same
 * folder), or null when `child` is not under `root`. Case-insensitive on Windows.
 */
function relativeWithin(root: string, child: string): string | null {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relativePath(norm(root), norm(child));
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * How a process started by a tool addresses files (#592), for the model to read
 * in the tool_result. A file has two addresses for an agent with workspaces:
 * `<label>/<path>` in the file tools, and a path relative to the process's cwd
 * (or absolute) in a process. On 2026-09-29 ComfyArtist ran
 * `comfy … --out-dir ComfyArtist/outputs` from the root of its "ComfyArtist"
 * workspace, and the file landed in ComfyArtist/ComfyArtist/outputs.
 *
 * Says the absolute cwd, which workspace it is — the DEEPEST one that contains
 * it when workspaces are nested — or `outside` when it is none (a skill
 * folder), what a file-tool path is called THERE (right for a sub-folder too,
 * never a literal that only holds at a workspace root), and every other
 * workspace by absolute path.
 *
 * The cwd a tool hands in is canonical (`resolveAndCheckPath` realpaths it);
 * a configured workspace path need not be (junction, symlink, subst, 8.3 name,
 * case). Both are compared in ONE path space, the real one (`cheminConstate`,
 * as #589 does for delivered files) — Nodal review of #593.
 *
 * Text written for the model. It travels in the tool_result, which the thread
 * and the Runs page also show; it says nothing the model's own call did not.
 */
export async function processAddressing(
  workspaces: readonly { label: string; path: string }[],
  cwd: string,
  outside = 'outside every workspace',
): Promise<string> {
  const reelCwd = await cheminConstate(cwd);
  const reels = await Promise.all(
    workspaces.map(async (w) => ({ w, root: await cheminConstate(w.path) })),
  );
  // Le conteneur le plus PROFOND : des espaces imbriqués nomment celui où l'on est.
  const home = reels
    .filter((r) => isWithin(r.root, reelCwd))
    .sort((x, y) => y.root.length - x.root.length)[0];
  const rel = home ? relativeWithin(home.root, reelCwd) : null;
  const where = home
    ? rel === ''
      ? `the root of workspace "${home.w.label}"`
      : `inside workspace "${home.w.label}"`
    : outside;
  const parts = [
    `This process ran in ${cwd}, ${where}.`,
    'Paths in a process are relative to that folder, or absolute.',
  ];
  if (home) {
    // Juste pour CE dossier : à la racine, `<label>/outputs/x` s'écrit
    // `outputs/x` ; depuis `<label>/a/b`, `<label>/a/b/x` s'écrit `x`.
    const ici = rel === '' ? 'outputs/x' : 'x';
    const outil = `${home.w.label}/${rel ? `${rel}/` : ''}${ici}`;
    parts.push(
      `Workspace labels are NOT folders for a process: what the file tools call ${outil} is ${ici} here.`,
    );
  } else {
    const exemple =
      workspaces.find((w) => w.label !== SHARED_WORKSPACE_LABEL)?.label ?? workspaces[0]?.label;
    if (exemple !== undefined) {
      parts.push(
        `Workspace labels are NOT folders for a process: use a workspace's absolute path, never ${exemple}/x.`,
      );
    }
  }
  const autres = workspaces.filter((w) => w !== home?.w);
  if (autres.length > 0) {
    parts.push(
      `${home ? 'Other workspaces' : 'Workspaces'}, by absolute path: ` +
        `${autres.map((w) => `${w.label} = ${w.path}`).join(', ')}.`,
    );
  }
  return parts.join(' ');
}

// ─── windowsPathViolation ─────────────────────────────────────────────────────

/**
 * Pure guard (no I/O) run BEFORE the `stat()` probing loop below. Catches
 * Windows-specific path shapes that are dangerous to even `stat()`:
 *
 *   1. UNC / protocol-relative path (`\\host\share\x`, `//host/share/x`) — all
 *      platforms, checked against BOTH `requestedPath` and `lexical`. No
 *      legitimate workspace path ever starts with two leading
 *      slashes/backslashes; `stat()`-ing one triggers an SMB connection (and
 *      an NTLM auth handshake — a credential leak) before the boundary check
 *      below would otherwise reject it.
 *   2. Reserved device name (`CON`, `NUL`, `COM1`, `LPT1`, …) at ANY segment
 *      — win32 only. Windows treats these as devices regardless of position
 *      or extension (`NUL.txt`, `nul. `); opening one can hang.
 *   3. Alternate Data Stream marker (`file.txt:hidden`, `foo::$DATA`) — win32
 *      only. A `:` after the optional drive letter opens a hidden NTFS stream
 *      instead of the real file.
 *
 * Checks 2 and 3 are win32-ONLY: `CON`/`NUL` and `:` are perfectly legal
 * filenames on POSIX, so gating them there would break Linux/macOS for no
 * reason. The `platform` param is injectable so tests are deterministic
 * regardless of the CI host's actual OS.
 *
 * IMPORTANT: checks 2 and 3 run over `requestedPath` (the caller-supplied
 * input) ONLY, never `lexical` (the fully-resolved path, which is prefixed by
 * the workspace/skill ROOT the user/admin configured). If the root itself
 * happens to contain a segment like "con" or a colon, that is not the
 * agent's doing and must not lock every file in the workspace out — the root
 * is trusted, only the path the agent supplies is untrusted input. The UNC
 * check has no such exception: a UNC path is never legitimate no matter
 * which side of the join it comes from, so it still checks both.
 *
 * Returns a human-readable violation reason, or `null` if the path is clean.
 */
export function windowsPathViolation(
  requestedPath: string,
  lexical: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const UNC_RE = /^[\\/]{2}/;
  if (UNC_RE.test(requestedPath) || UNC_RE.test(lexical)) {
    return `Path "${requestedPath}" looks like a UNC/network path (starts with two slashes), which is never a valid workspace path.`;
  }

  if (platform !== 'win32') return null;

  const DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  for (const seg of requestedPath.split(/[\\/]+/).filter(Boolean)) {
    // Windows reserves the device name at the segment's leading component
    // regardless of how many extensions follow, and regardless of trailing
    // dots/spaces: "aux.config.js", "con.txt.bak", "nul.tar.gz", "con. " all
    // resolve to their device. This DOES mean a project file literally named
    // "aux.config.js" is unreachable through this guard — but that mirrors
    // real Windows behavior (such a file is unreachable through the normal
    // filesystem API on an actual Windows box too), so this is an accepted,
    // OS-faithful trade-off rather than an over-eager guard.
    const base = (seg.split('.')[0] ?? '').replace(/\s+$/, '');
    if (DEVICE_RE.test(base)) {
      return `Path segment "${seg}" is a reserved Windows device name ("${base.toUpperCase()}"), never a legitimate workspace target.`;
    }
  }

  const withoutDriveLetter = requestedPath.replace(/^[a-zA-Z]:/, '');
  if (withoutDriveLetter.includes(':')) {
    return `Path "${requestedPath}" contains an Alternate Data Stream marker (":"), which is never a legitimate workspace target.`;
  }

  return null;
}

// ─── resolveUnderRoot (private) ──────────────────────────────────────────────

/** Links followed while resolving one path before it is refused (Linux's own bound is 40). */
const MAX_LINK_HOPS = 40;

/**
 * The target of `path` when it is a link (symlink, or a Windows junction,
 * which lstat reports as one), as a path; null when it is not a link or does
 * not exist.
 */
async function danglingLinkTarget(path: string): Promise<string | null> {
  const isLink = await lstat(path).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  if (!isLink) return null;
  return linkTargetAsPath(await readlink(path));
}

/**
 * A link target as Windows writes it, turned into the path it names. Windows
 * returns it with a `\\?\` (or NT `\??\`) prefix: `\\?\C:\x` is the drive
 * path `C:\x`, but `\\?\UNC\server\share\x` is the SHARE `\\server\share\x`
 * (revue de la PR #618, passe 4 : retirer le préfixe laissait `UNC\server\…`,
 * lu comme un chemin relatif sous le dossier du lien). Any other prefixed
 * form (`\\?\Volume{…}\`, a device) is no drive path either, and is returned
 * in the `\\` form a UNC check refuses.
 */
export function linkTargetAsPath(raw: string): string {
  const prefixed = /^(?:\\\\\?\\|\\\?\?\\)(.*)$/.exec(raw);
  if (!prefixed) return raw;
  const rest = prefixed[1] ?? '';
  if (/^[A-Za-z]:[\\/]/.test(rest)) return rest;
  if (/^UNC[\\/]/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return `\\\\${rest}`;
}

/**
 * Where an absolute path really lands on disk: the deepest existing ancestor,
 * realpath()'d, plus the part that does not exist yet. Links are followed on
 * the way, dangling ones included (#614, revue Nodal de la PR #618, passe 3):
 * stat() follows a link whose target does not exist yet and fails, yet a
 * write to this path goes through it and creates its target. Walking up to
 * the parent judged the link's NAME lexically, inside the workspace, while the
 * write landed wherever it points.
 *
 * A link to a network share is never stat()'d (that is the SMB leak the UNC
 * check exists for): the walk stops there and `share` says why, with
 * `canonical` the share path. Exported so a caller can NAME where a path
 * leads, not only whether it is inside (the approval card, #618).
 */
export async function followLinks(
  lexical: string,
  requestedPath: string = lexical,
): Promise<{ canonical: string; share: string | null }> {
  // The walk below cuts `path` at the length of `probe`, so both must be the
  // same text: a rooted path with no drive (`/dev/null`) is walked up as
  // `D:\dev`, three characters longer than the ancestor it started from, and
  // the cut landed inside a word (`D:\v/null`, #669). Resolved once, here, for
  // every caller.
  let path = resolvePath(lexical);
  let probe = path;
  let hops = 0;
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
    const target = await danglingLinkTarget(probe);
    if (target !== null) {
      if (++hops > MAX_LINK_HOPS) {
        throw new WorkspaceError(
          'path_traversal_blocked',
          `Path "${requestedPath}" goes through more than ${MAX_LINK_HOPS} links.`,
        );
      }
      const through = resolvePath(dirname(probe), target);
      path = through + path.slice(probe.length);
      const linkViolation = windowsPathViolation(target, through);
      if (linkViolation) return { canonical: path, share: linkViolation };
      probe = path;
      continue;
    }
    const parent = resolvePath(probe, '..');
    if (parent === probe) {
      throw new WorkspaceError(
        'path_traversal_blocked',
        `Cannot resolve "${requestedPath}" — walked past the filesystem root.`,
      );
    }
    probe = parent;
  }
  const realProbe = await realpath(probe);
  return { canonical: realProbe + path.slice(probe.length), share: null };
}

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

  // Reject dangerous Windows path shapes (UNC, device names, ADS) BEFORE the
  // stat() probing below — stat()-ing a UNC path triggers an SMB/NTLM
  // handshake, which is itself the leak we're guarding against.
  const violation = windowsPathViolation(requestedPath, lexical);
  if (violation) {
    throw new WorkspaceError('path_traversal_blocked', violation);
  }

  // Boundary check: canonical MUST start with realRoot + path separator
  // (or equal realRoot itself). Without the separator suffix, "/work" would
  // accidentally match "/workplace/secret".
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

  /**
   * Walk up to find the deepest existing ancestor of the lexical path, then
   * realpath() that. This lets us validate paths whose intermediate directories
   * don't exist yet (e.g. file_write with create_dirs:true creating
   * `nested/dir/new.txt` from scratch) while still catching symlink escapes on
   * any segment that DOES exist on disk.
   *
   * F-23 (TOCTOU hardening): the not-yet-existing suffix is necessarily
   * checked lexically only (there's nothing on disk yet to realpath) — a
   * symlink planted at one of its segments AFTER this walk has run still
   * escapes detection by a single pass. This helper is therefore re-run a
   * second time, as late as possible, right before resolveUnderRoot returns
   * (see below) so a plant landing mid-resolution is still caught by fresh
   * stat()/realpath() calls. This narrows, but cannot fully close, the
   * window: a plant landing between the final call below and the caller's
   * own fs syscall is a residual race that only O_NOFOLLOW at every call
   * site's actual open/write could close — out of scope for this hardening.
   */
  async function probeCanonical(): Promise<string> {
    const followed = await followLinks(lexical, requestedPath);
    if (followed.share !== null) throw new WorkspaceError('path_traversal_blocked', followed.share);
    const canonical = followed.canonical;

    if (canonical !== realRoot && !canonical.startsWith(rootWithSep)) {
      throw new WorkspaceError(
        'path_traversal_blocked',
        `Path "${requestedPath}" resolves to "${canonical}", outside the workspace "${realRoot}".`,
      );
    }
    return canonical;
  }

  await probeCanonical();
  return probeCanonical();
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

// ─── Shared-workspace overwrite gate (D1) ─────────────────────────────────────

/**
 * Whether an already-resolved canonical path (as returned by
 * resolveAndCheckPath) lives inside the entity-wide SHARED workspace — the
 * auto-injected common scratch/hand-off area addressed via the "shared/"
 * label (see SHARED_WORKSPACE_LABEL). A workspace the OWNER explicitly
 * attached (agent_workspaces — e.g. an Obsidian vault) carries its own,
 * different label and never matches here, by construction: this is a pure
 * label lookup, not a heuristic. Returns false (not gated) if the agent has
 * no shared workspace or its root can't be resolved.
 */
export async function isPathInSharedWorkspace(
  ctx: ToolContext,
  resolvedPath: string,
): Promise<boolean> {
  const shared = ctx.workspaces?.find((ws) => ws.label === SHARED_WORKSPACE_LABEL);
  if (!shared) return false;
  const realShared = await realpath(shared.path).catch(() => undefined);
  if (!realShared) return false;
  const rootWithSep = realShared.endsWith(sep) ? realShared : realShared + sep;
  return resolvedPath === realShared || resolvedPath.startsWith(rootWithSep);
}

// ─── Protected workflow templates (P4) ─────────────────────────────────────────

/**
 * Pure predicate: does this path (relative to the SHARED workspace root,
 * forward-slash normalised) point at a shared canonical ComfyUI workflow
 * template — a `.json` file under a `workflows/` directory? Case-insensitive
 * on both the `workflows` segment and the `.json` extension so
 * `Workflows/Foo.JSON` doesn't slip through on a case-insensitive filesystem
 * quirk. No I/O — pure string logic, unit-tested in isolation.
 */
export function isProtectedWorkflowTemplatePath(relPath: string): boolean {
  const normalised = relPath.replace(/\\/g, '/');
  const segments = normalised.split('/').filter(Boolean);
  if (segments.length < 2) return false; // needs ≥1 dir segment + the file itself
  const file = segments[segments.length - 1] ?? '';
  if (!/\.json$/i.test(file)) return false;
  return segments.slice(0, -1).some((seg) => seg.toLowerCase() === 'workflows');
}

/**
 * P4 (causality study, 2026-07-22): shared canonical workflow templates —
 * e.g. `workflows/Krea2_Turbo.json` in the entity-wide SHARED workspace —
 * are READ-ONLY to file_write/file_edit. The intended pattern for a per-run
 * customization is runtime parameter injection (the ComfyUI skill's
 * `run_workflow.py --args`), never mutating the template file in place.
 * Live incident: a delegated worker (ComfyArtist) called `file_edit`
 * directly on the shared template, overwriting its prompt/seed/aspect_ratio
 * scene-to-scene and contaminating every later run that shared it.
 *
 * Applies to ALL callers, not just delegated workers: `ToolContext` carries
 * no delegation status today (see execute.ts's worker-vs-orchestrator split,
 * which lives one layer up in the runner and never reaches these builtins),
 * and a canonical template arguably shouldn't be hand-edited by ANY agent
 * through an ad hoc tool call anyway — deliberate template changes belong in
 * a dedicated authoring flow, not a turn's file_edit. Scoped to the SHARED
 * workspace only: a private/attached workspace's own `workflows/` folder (if
 * one exists) is that agent's own business, not a cross-run-contamination
 * risk shared with anyone else.
 *
 * `resolvedPath` must already be the canonical absolute path returned by
 * `resolveAndCheckPath` — this only classifies it, it does not resolve it.
 */
export async function isProtectedWorkflowTemplate(
  ctx: ToolContext,
  resolvedPath: string,
): Promise<boolean> {
  if (!(await isPathInSharedWorkspace(ctx, resolvedPath))) return false;
  const shared = ctx.workspaces?.find((ws) => ws.label === SHARED_WORKSPACE_LABEL);
  if (!shared) return false;
  const realShared = await realpath(shared.path).catch(() => undefined);
  if (!realShared) return false;
  const rel = resolvedPath.slice(realShared.length).replace(/^[\\/]/, '');
  return isProtectedWorkflowTemplatePath(rel);
}

/** Steering error message for a file_write/file_edit call blocked by P4 above. */
export const WORKFLOW_TEMPLATE_PROTECTED_MESSAGE =
  'This path is a shared canonical ComfyUI workflow template (workflows/*.json in the shared ' +
  "workspace) — templates are read-only. Pass parameters at run time via the ComfyUI skill's " +
  '`run_workflow` script (`--args`) instead of editing the template file. Editing the template ' +
  'directly mutates it for every other run that shares it.';

/**
 * D1 gate: file_write/file_edit only need a human in the loop when the call
 * would OVERWRITE an EXISTING file inside the shared workspace — never for a
 * brand-new file, and never for an attached or private workspace. Wired as
 * each tool's `computeApproval` hook (see ToolDefinition) so the decision is
 * made PER CALL instead of a blanket `defaultApproval` that would gate every
 * write regardless of target.
 *
 * Resolution failures (bad path, no workspace configured, path traversal…)
 * return undefined — the call is about to fail loud in execute() anyway;
 * there is nothing destructive to gate.
 *
 * A file whose CURRENT content is the one THIS run wrote is not another
 * run's work (#505): re-writing it overwrites nothing anyone else made, so it
 * is not gated. Content, not record order, decides (see
 * `currentContentWrittenByJob`): an edit made outside Nodal, or a later write
 * by another run, puts the gate back. Every caller (file_write, file_edit, generate_speech) gets the same
 * answer from the same record, `constated_writes`.
 */
export async function computeSharedOverwriteApproval(
  ctx: ToolContext,
  requestedPath: string,
): Promise<'require_approval' | undefined> {
  let resolved: string;
  try {
    resolved = await resolveAndCheckPath(ctx, requestedPath);
  } catch {
    return undefined;
  }
  if (!(await isPathInSharedWorkspace(ctx, resolved))) return undefined;
  const exists = await stat(resolved).then(
    () => true,
    () => false,
  );
  if (!exists) return undefined;
  return (await currentContentWrittenByJob(ctx.db, ctx.jobId, resolved))
    ? undefined
    : 'require_approval';
}
