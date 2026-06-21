// skill-ops/skill-files.ts — read the bundled files of an installed community
// skill (open Agent Skills / SKILL.md format).
//
// WHY a dedicated tool instead of file_read: the file_* tools are strictly
// scoped to the agent's WORKSPACE (see file-ops/workspace.ts) and refuse any
// path outside it. A community skill's bundled files live in a separate
// install store (`<skillStoreDir>/<slug>/`), not the workspace — so the agent
// needs a purpose-built reader. This mirrors how Hermes exposes `skill_view`.
//
// SECURITY: this module enforces its own path boundary (realpath + prefix
// check, the same proven technique as workspace.ts) so a malicious `path` like
// `../../secrets.key` cannot escape the skill folder, and an agent can only
// read the bundle of a skill it actually holds (assignedSkillSlugs). The
// boundary logic is intentionally self-contained — it does NOT touch the
// universal workspace guard, so this feature cannot regress file_* security.

import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { resolve as resolvePath, join as joinPath, sep, isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';

/** Max bytes returned by a single skill_file_read call (same cap as file_read). */
const MAX_READ_BYTES = 1024 * 1024;
/** Max entries returned by a single skill_file_list call. */
const MAX_LIST_ENTRIES = 1000;

/** Slug shape mirrors the open spec: lowercase alphanumerics + single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillFileError extends Error {
  readonly code:
    | 'skill_store_unavailable'
    | 'invalid_slug'
    | 'skill_not_assigned'
    | 'skill_not_installed'
    | 'path_escape';
  constructor(
    code:
      | 'skill_store_unavailable'
      | 'invalid_slug'
      | 'skill_not_assigned'
      | 'skill_not_installed'
      | 'path_escape',
    message: string,
  ) {
    super(message);
    this.name = 'SkillFileError';
    this.code = code;
  }
}

/**
 * Resolve the canonical, existing root directory of an installed skill, after
 * verifying (1) the store is configured, (2) the slug is well-formed, (3) the
 * agent actually holds this skill, and (4) the skill is installed on disk.
 */
export async function resolveSkillRoot(ctx: ToolContext, slug: string): Promise<string> {
  if (!ctx.skillStoreDir || !isAbsolute(ctx.skillStoreDir)) {
    throw new SkillFileError(
      'skill_store_unavailable',
      'The skill store is not available in this environment.',
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new SkillFileError(
      'invalid_slug',
      `Invalid skill slug "${slug}". Use the skill's slug (lowercase, hyphenated).`,
    );
  }
  const assigned = ctx.assignedSkillSlugs ?? [];
  if (!assigned.includes(slug)) {
    throw new SkillFileError(
      'skill_not_assigned',
      `Skill "${slug}" is not assigned to this agent, so its files cannot be read. ` +
        `Assigned skills: ${assigned.length ? assigned.join(', ') : '(none)'}.`,
    );
  }
  const root = resolvePath(ctx.skillStoreDir, slug);
  try {
    return await realpath(root);
  } catch {
    throw new SkillFileError(
      'skill_not_installed',
      `Skill "${slug}" has no files in the skill store (not installed, or install incomplete).`,
    );
  }
}

/**
 * Resolve `requestedPath` (relative to the skill root) and guarantee it stays
 * inside `realRoot`, defeating `..` and symlink escapes. Same two-pass
 * technique as file-ops/workspace.ts: lexical resolve → realpath the deepest
 * existing ancestor → prefix-check the canonical path against the root.
 */
export async function resolveWithinSkill(realRoot: string, requestedPath: string): Promise<string> {
  const lexical = isAbsolute(requestedPath)
    ? resolvePath(requestedPath)
    : resolvePath(realRoot, requestedPath);

  // Walk up to the deepest existing ancestor, then realpath it — catches
  // symlink escapes on any segment that exists on disk while still allowing
  // not-yet-existing tail segments (harmless for a read, but keeps parity).
  let probe = lexical;
  for (;;) {
    try {
      await stat(probe);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SkillFileError(
          'path_escape',
          `Failed to resolve "${requestedPath}" within the skill folder.`,
        );
      }
    }
    const parent = resolvePath(probe, '..');
    if (parent === probe) {
      throw new SkillFileError(
        'path_escape',
        `Cannot resolve "${requestedPath}" — walked past the filesystem root.`,
      );
    }
    probe = parent;
  }
  const realProbe = await realpath(probe);
  const canonical = realProbe + lexical.slice(probe.length);

  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (canonical !== realRoot && !canonical.startsWith(rootWithSep)) {
    throw new SkillFileError(
      'path_escape',
      `Path "${requestedPath}" resolves outside the skill folder.`,
    );
  }
  return canonical;
}

// ─── skill_file_read ────────────────────────────────────────────────────────

export const SkillFileReadInputSchema = z.object({
  skill: z.string().min(1).describe("The skill's slug (its installed identifier)."),
  path: z
    .string()
    .min(1)
    .describe("Path to a bundled file, relative to the skill's folder (e.g. 'references/x.md')."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('1-based line number to start at. Default 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe('Max number of lines to return. Default 500.'),
});

export type SkillFileReadInput = z.infer<typeof SkillFileReadInputSchema>;
export type SkillFileReadOutput =
  | {
      ok: true;
      content: string;
      total_lines: number;
      start_line: number;
      end_line: number;
      truncated: boolean;
    }
  | { ok: false; reason: string };

export const skillFileReadTool: ToolDefinition<
  typeof SkillFileReadInputSchema,
  SkillFileReadOutput
> = {
  name: 'skill_file_read',
  description:
    "Read a bundled file that ships with one of this agent's installed skills " +
    '(reference docs, templates, stylesheets, presets). Use this for on-demand ' +
    "loading of a skill's resources — the skill's instructions tell you which " +
    'files to read. Paginate large files with offset/limit. This reads the ' +
    "skill's own files only, never the agent workspace (use file_read for that).",
  inputSchema: SkillFileReadInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      const realRoot = await resolveSkillRoot(ctx, input.skill);
      const path = await resolveWithinSkill(realRoot, input.path);
      const info = await stat(path);
      if (info.isDirectory()) {
        return {
          ok: false,
          reason: `Path is a directory, not a file: "${input.path}". Use skill_file_list.`,
        };
      }
      if (info.size > MAX_READ_BYTES && input.offset === undefined && input.limit === undefined) {
        return {
          ok: false,
          reason: `File is ${info.size} bytes (> ${MAX_READ_BYTES}). Call again with explicit offset and limit.`,
        };
      }
      const raw = await readFile(path, 'utf8');
      const allLines = raw.split('\n');
      const offset = input.offset ?? 1;
      const limit = input.limit ?? 500;
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);
      return {
        ok: true,
        content: allLines.slice(startIdx, endIdx).join('\n'),
        total_lines: allLines.length,
        start_line: startIdx + 1,
        end_line: endIdx,
        truncated: endIdx < allLines.length,
      };
    } catch (err) {
      if (err instanceof SkillFileError) return { ok: false, reason: err.message };
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: `File not found: "${input.path}".` };
      }
      throw err;
    }
  },
};

// ─── skill_file_list ──────────────────────────────────────────────────────────

export const SkillFileListInputSchema = z.object({
  skill: z.string().min(1).describe("The skill's slug (its installed identifier)."),
  path: z
    .string()
    .optional()
    .describe("Subfolder to list, relative to the skill's root. Default: the skill root."),
});

export type SkillFileListInput = z.infer<typeof SkillFileListInputSchema>;
export type SkillFileListOutput =
  | { ok: true; entries: Array<{ path: string; type: 'file' | 'dir' }>; truncated: boolean }
  | { ok: false; reason: string };

export const skillFileListTool: ToolDefinition<
  typeof SkillFileListInputSchema,
  SkillFileListOutput
> = {
  name: 'skill_file_list',
  description:
    "List the bundled files that ship with one of this agent's installed skills, " +
    'so you can discover which resources (references, templates, presets) are ' +
    'available before reading them with skill_file_read. Returns paths relative ' +
    "to the skill's root.",
  inputSchema: SkillFileListInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      const realRoot = await resolveSkillRoot(ctx, input.skill);
      const startDir = await resolveWithinSkill(realRoot, input.path ?? '.');
      const info = await stat(startDir);
      if (!info.isDirectory()) {
        return { ok: false, reason: `Path is a file, not a directory: "${input.path}".` };
      }

      const entries: Array<{ path: string; type: 'file' | 'dir' }> = [];
      let truncated = false;
      const stack: string[] = [startDir];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const d of dirents) {
          if (entries.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            break;
          }
          const abs = joinPath(dir, d.name);
          const rel = relative(realRoot, abs).split(sep).join('/');
          if (d.isDirectory()) {
            entries.push({ path: rel, type: 'dir' });
            stack.push(abs);
          } else if (d.isFile()) {
            entries.push({ path: rel, type: 'file' });
          }
        }
        if (truncated) break;
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { ok: true, entries, truncated };
    } catch (err) {
      if (err instanceof SkillFileError) return { ok: false, reason: err.message };
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: `Path not found: "${input.path ?? '.'}".` };
      }
      throw err;
    }
  },
};
