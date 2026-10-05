// shell-checklist.ts — what an agent may NOT do with a shell, per kind of action (#464).
//
// Run 06a949cb → b4b493e8 (23/09): under `destructive_gate`, an agent ran
// commands no one was asked about, and the only fine control was a free-text
// list of programs that even the owner "would not know what to write in".
// What a person CAN judge is a kind of action: delete, install, download… Each
// one gets a state per agent: allowed, ask me, never.
//
// Every kind here is read from the command TEXT (`staticShellCategories`,
// catastrophic-command.ts): the programs it runs, as Hermes Agent reads them,
// and the code the command runs, a script it names or code written into it,
// read with the same classifier (program-sources.ts, #635). A text reading
// cannot follow where a path built at run time leads, nor code fetched or
// assembled while the program runs; the reviews of PR #474 showed that trying
// to only moves the hole. Keeping an agent inside its folders is the job of an
// OS-level sandbox (#628), not of this list, and the screen says so.
//
// Pure: no filesystem, no `node:path` (the web imports this module too).

import { z } from 'zod';
import type { StaticShellCategory } from './catastrophic-command';

/** Every kind of action the checklist covers, in the order the screen lists them. */
export const SHELL_CATEGORIES = [
  'inline_code',
  'delete_files',
  'install_software',
  'download',
  'stop_programs',
  'system_settings',
] as const satisfies readonly StaticShellCategory[];

export type ShellCategory = (typeof SHELL_CATEGORIES)[number];

/** Allowed: runs without asking. Ask: an approval first. Never: blocked, the agent is told why. */
export const SHELL_CATEGORY_STATES = ['allow', 'ask', 'never'] as const;
export type ShellCategoryState = (typeof SHELL_CATEGORY_STATES)[number];

export type ShellPolicy = Record<ShellCategory, ShellCategoryState>;

/**
 * What an agent nobody configured may do without asking. An autonomous agent
 * asks only for what leaves its workspace or cannot be undone (#614, the
 * owner's rule of 29/09: three runs that day stopped on a card asking whether
 * an agent could download a picture into its own folder).
 *
 * - `download` runs, when it writes into the job's workspaces; a target
 *   outside them (or one the text cannot read) asks.
 * - `inline_code` runs: code written into a command is the same power as a
 *   script the agent writes and runs, which never asked. Telling "code from
 *   the web" apart by reading the text is not a boundary (the owner's
 *   explicit decision of 29/09); keeping an agent's code in bounds is an OS
 *   sandbox's job, as the top of this file says.
 * - Deleting, installing, stopping programs and system settings ask: they
 *   reach the machine beyond the agent, or cannot be undone from the screen
 *   yet (#617).
 */
export const DEFAULT_SHELL_POLICY: ShellPolicy = {
  inline_code: 'allow',
  delete_files: 'ask',
  install_software: 'ask',
  download: 'allow',
  stop_programs: 'ask',
  system_settings: 'ask',
};

/** What is stored per agent (`agents.shell_policy`): only the states someone set. */
const StateSchema = z.enum(SHELL_CATEGORY_STATES).optional();
export const StoredShellPolicySchema = z
  .object({
    inline_code: StateSchema,
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
  /** The commands of the call that did it, as written. */
  details: string[];
  /**
   * For a download the agent may do without asking: per command, the places it
   * would write that are not inside one of the job's workspaces (#614). Only
   * then does an allowed download ask, and this says why.
   */
  outside?: Array<{ command: string; places: string[] }>;
  /**
   * Where this kind was found in the code the call runs (#635): a script it
   * names (`source`, as written) or the code written into the command
   * (`source: null`), the line, and that line as written.
   */
  found?: ShellSourceFinding[];
  /**
   * The scripts the call runs that could not be read, and why (#635). Code
   * nobody could read ahead: carried by an `inline_code` reason, under that
   * kind's state.
   */
  unread?: ShellUnreadSource[];
}

export interface ShellSourceFinding {
  source: string | null;
  line: number;
  text: string;
}

/** Why a script a command runs could not be read (#635). */
export const SHELL_UNREAD_REASONS = [
  'outside_workspaces',
  'not_found',
  'too_large',
  'decided_at_run_time',
  'not_a_file',
  'unreadable',
] as const;

export interface ShellUnreadSource {
  /** As written in the command, or the text standing for it. */
  source: string;
  why: (typeof SHELL_UNREAD_REASONS)[number];
}

/** `approval_requests.gate_reasons` as stored, read back for the approval card. */
export const ShellGateReasonsSchema = z.array(
  z.object({
    category: z.enum(SHELL_CATEGORIES),
    state: z.enum(['ask', 'never']),
    details: z.array(z.string()),
    outside: z.array(z.object({ command: z.string(), places: z.array(z.string()) })).optional(),
    found: z
      .array(z.object({ source: z.string().nullable(), line: z.number().int(), text: z.string() }))
      .optional(),
    unread: z.array(z.object({ source: z.string(), why: z.enum(SHELL_UNREAD_REASONS) })).optional(),
  }),
);
