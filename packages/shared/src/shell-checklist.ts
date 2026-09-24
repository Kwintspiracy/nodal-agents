// shell-checklist.ts — what an agent may NOT do with a shell, per kind of action (#464).
//
// Run 06a949cb → b4b493e8 (23/09): under `destructive_gate`, an agent ran
// commands no one was asked about, and the only fine control was a free-text
// list of programs that even the owner "would not know what to write in".
// What a person CAN judge is a kind of action: delete, install, download… Each
// one gets a state per agent: allowed, ask me, never.
//
// Every kind here is read from the command TEXT (`staticShellCategories`,
// catastrophic-command.ts): the programs it runs, as Hermes Agent reads them.
// A text reading cannot follow what a script does once it runs, nor where a
// path built at run time leads; the reviews of PR #474 showed that trying to
// only moves the hole. Keeping an agent inside its folders is the job of an
// OS-level sandbox, not of this list, and the screen says so.
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
 * An agent nobody configured asks before every kind of action on the list:
 * what `destructive_gate` has always asked about. A false "ask" is cheap; a
 * silent `rm` is not.
 */
export const DEFAULT_SHELL_POLICY: ShellPolicy = {
  inline_code: 'ask',
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
}

/** `approval_requests.gate_reasons` as stored, read back for the approval card. */
export const ShellGateReasonsSchema = z.array(
  z.object({
    category: z.enum(SHELL_CATEGORIES),
    state: z.enum(['ask', 'never']),
    details: z.array(z.string()),
  }),
);
