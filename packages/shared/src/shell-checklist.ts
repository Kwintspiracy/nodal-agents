// shell-checklist.ts — what an agent may NOT do with a shell, per kind of action (#464).
//
// Run 06a949cb → b4b493e8 (23/09): with the workspace at `destructive_gate`, an
// agent wrote a Python script and ran it through `run_command` on files in
// Downloads and Documents — folders it had never been given. No one was asked:
// the command was "ordinary". Attaching folders looked like a boundary and was
// not one, and the only fine control was a free-text list of programs that
// even the owner "would not know what to write in".
//
// What a person CAN judge is what the agent must not do. This module names
// those kinds of action, and each one gets a state per agent: allowed, ask me,
// never. The kinds read from the command text alone come from
// `staticShellCategories` (catastrophic-command.ts, the same patterns
// `destructive_gate` has always gated); the two that need context — a path
// outside the agent's folders, a script it wrote itself — are judged by the
// tools layer, which knows the folders and the job.
//
// Pure: no filesystem, no `node:path` (the web imports this module too).

import { z } from 'zod';
import { splitShellWords, type StaticShellCategory } from './catastrophic-command';

/** Every kind of action the checklist covers, in the order the screen lists them. */
export const SHELL_CATEGORIES = [
  'outside_folders',
  'own_script',
  'delete_files',
  'install_software',
  'download',
  'stop_programs',
  'system_settings',
] as const satisfies readonly (StaticShellCategory | 'outside_folders' | 'own_script')[];

export type ShellCategory = (typeof SHELL_CATEGORIES)[number];

/** Allowed: runs without asking. Ask: an approval first. Never: blocked, the agent is told why. */
export const SHELL_CATEGORY_STATES = ['allow', 'ask', 'never'] as const;
export type ShellCategoryState = (typeof SHELL_CATEGORY_STATES)[number];

export type ShellPolicy = Record<ShellCategory, ShellCategoryState>;

/**
 * An agent nobody configured asks before every kind of action on the list.
 * A false "ask" is cheap; a silent read of someone's Documents is not.
 */
export const DEFAULT_SHELL_POLICY: ShellPolicy = {
  outside_folders: 'ask',
  own_script: 'ask',
  delete_files: 'ask',
  install_software: 'ask',
  download: 'ask',
  stop_programs: 'ask',
  system_settings: 'ask',
};

/** What is stored per agent (`agents.shell_policy`): only the states someone set. */
const StateSchema = z.enum(SHELL_CATEGORY_STATES).optional();
export const StoredShellPolicySchema = z
  .object({
    outside_folders: StateSchema,
    own_script: StateSchema,
    delete_files: StateSchema,
    install_software: StateSchema,
    download: StateSchema,
    stop_programs: StateSchema,
    system_settings: StateSchema,
  } satisfies Record<ShellCategory, typeof StateSchema>)
  .strict();

export type StoredShellPolicy = z.infer<typeof StoredShellPolicySchema>;

/**
 * The policy an agent runs under: what is stored, the default for the rest.
 * A stored value that does not parse is an error, not a silent default — a
 * corrupted "never" read as "ask" would weaken a boundary the owner set
 * (invariant #4).
 */
export function resolveShellPolicy(stored: unknown): ShellPolicy {
  if (stored === null || stored === undefined) return { ...DEFAULT_SHELL_POLICY };
  const parsed = StoredShellPolicySchema.parse(stored);
  const policy = { ...DEFAULT_SHELL_POLICY };
  for (const c of SHELL_CATEGORIES) {
    const state = parsed[c];
    if (state !== undefined) policy[c] = state;
  }
  return policy;
}

/** One reason a command was stopped or held, as stored on the approval (`gate_reasons`). */
export interface ShellGateReason {
  category: ShellCategory;
  state: Exclude<ShellCategoryState, 'allow'>;
  /** The paths or scripts that made it so, as the command wrote them. Empty when the kind alone says it. */
  details: string[];
}

/** A path written in a command, before anything resolves it. */
export interface PathWord {
  /** As written, quotes removed. */
  raw: string;
  /** Absolute (drive, UNC, root), in the home folder (`~`, %USERPROFILE%), or relative to where it runs. */
  kind: 'absolute' | 'home' | 'relative';
}

const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;
const UNC = /^(\\\\|\/\/)[^\\/]/;
const HOME = /^(~(?=[\\/]|$)|%userprofile%|%homepath%|\$home\b|\$env:userprofile\b)/i;
/** A URL is not a path, even with slashes in it. */
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The words of a command that name a path: an argument, an option's value
 * (`--out=C:\x`), a redirection target. The program each segment starts with
 * is left out when it is a program (`C:\Python311\python.exe`): running a
 * program is not reading or changing files. On Windows, `/x` is a flag
 * (`rd /s`, `taskkill /F`), not a path, unless it has a second separator.
 */
export function pathWords(cmd: string, platform: string): PathWord[] {
  const found: PathWord[] = [];
  for (const segment of splitShellWords(cmd)) {
    segment.forEach((word, index) => {
      if (index === 0 && !/\.(sh|bash|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i.test(word)) return;
      const value = /^--?[\w-]+=/.test(word) ? word.slice(word.indexOf('=') + 1) : word;
      if (value === '') return;
      if (WINDOWS_ABSOLUTE.test(value) || UNC.test(value)) {
        found.push({ raw: value, kind: 'absolute' });
      } else if (value.startsWith('/')) {
        const unixPath = platform !== 'win32' || value.indexOf('/', 1) > 0;
        if (unixPath) found.push({ raw: value, kind: 'absolute' });
      } else if (HOME.test(value)) {
        found.push({ raw: value, kind: 'home' });
      } else if (!value.startsWith('-') && !URL.test(value)) {
        // Every other word is a relative path candidate, not only those that
        // climb (`..`): `cat link/secret`, where `link` is a symlink inside the
        // folder pointing outside it, never climbs and still leaves (Codex
        // review of #464, P1). The caller resolves each one as the file tools
        // do, symlinks included; a word that is not a path (`status`, `42`)
        // resolves inside the folder and says nothing.
        found.push({ raw: value, kind: 'relative' });
      }
    });
  }
  return found;
}
