// shell-checklist.ts — judging a shell command against the agent's checklist (#464).
//
// Each command the call will run is read for the kinds of action it performs
// (`staticShellCategories`, packages/shared), and the state the owner gave
// each kind applies. What it returns is FACTS: one reason per kind whose state
// is `ask` or `never`, with the commands that did it. The caller
// (`executeTool`) turns them into a block or an approval, and stores them on
// the approval so the card can show them.
//
// A reading of the text, like Hermes Agent's: it does not follow what a script
// does once it runs, and it does not keep an agent inside its folders. That
// takes an OS-level sandbox.
//
// One exception to "reading the text only", and it is the definition of an
// allowed download (#614, revue Nodal de la PR #618, P1b): a download runs
// without asking because it lands in the agent's workspace, where a checkpoint
// keeps what it replaces. So the places a download writes (`downloadWrites`)
// are resolved against the command's working folder and the job's workspaces;
// one outside them, or one the text does not name, asks.

import { isAbsolute, resolve } from 'node:path';
import {
  downloadWrites,
  staticShellCategories,
  type ShellCategory,
  type ShellGateReason,
  type ShellPolicy,
} from '@nodal-agents/shared';

/** Where the commands of a call run: what an allowed download is judged against. */
export interface ShellPlace {
  /** The folder the commands start in, canonical; null when it cannot be resolved. */
  cwd: string | null;
  /** True when an absolute path lies inside one of the job's workspaces. */
  inWorkspace(absolutePath: string): Promise<boolean>;
  /** Where an absolute path really lands, links followed; null when it cannot be told. */
  leadsTo(absolutePath: string): Promise<string | null>;
}

/** Two absolute paths name the same place (case-insensitive on Windows). */
function samePlace(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** What an unreadable target (a variable, `~`, a sub-shell) is called on the card. */
const UNREADABLE_TARGET = 'a path decided when the command runs';

/**
 * The places `command` would download to that are not inside a workspace of
 * the job, as written. A relative target is judged from the folder the line is
 * in when it runs: the starting folder, then each `cd` that comes BEFORE it
 * (revue passe 2 : un `cd` écrit après ne la déplace pas). A redirection,
 * whose place in the line is not known, is judged from every folder of it.
 */
async function downloadsOutside(command: string, place: ShellPlace): Promise<string[]> {
  const { dirs, targets } = downloadWrites(command);
  if (targets.length === 0) return [];
  const bases: Array<string | null> = [place.cwd];
  let base = place.cwd;
  for (const dir of dirs) {
    base = base === null || dir === null ? null : resolve(base, dir);
    bases.push(base);
  }
  const outside: string[] = [];
  for (const { path, after } of targets) {
    if (path === null) {
      if (!outside.includes(UNREADABLE_TARGET)) outside.push(UNREADABLE_TARGET);
      continue;
    }
    const from = after === null ? bases : [bases[after] ?? null];
    const candidates = isAbsolute(path)
      ? [path]
      : from.map((b) => (b === null ? null : resolve(b, path)));
    for (const candidate of candidates) {
      if (candidate === null || !(await place.inWorkspace(candidate))) {
        // The card names what was judged: the path as written, and where it
        // leads when a link takes it elsewhere (`out/a.jpg → C:\…`), never a
        // name that only looks inside (revue Nodal de la PR #618).
        const to = candidate === null ? null : await place.leadsTo(candidate);
        const named = to !== null && !samePlace(to, candidate ?? '') ? `${path} → ${to}` : path;
        if (!outside.includes(named)) outside.push(named);
        break;
      }
    }
  }
  return outside;
}

/** Judge `commands` (the ones this call will run, from `place`) against `policy`. */
export async function judgeShellChecklist(
  commands: readonly string[],
  policy: ShellPolicy,
  place: ShellPlace,
): Promise<ShellGateReason[]> {
  const details = new Map<ShellCategory, string[]>();
  // Each command's own places outside, attached to it (revue passe 2).
  const outside: NonNullable<ShellGateReason['outside']> = [];
  const add = (category: ShellCategory, command: string): void => {
    const list = details.get(category) ?? [];
    if (!list.includes(command)) list.push(command);
    details.set(category, list);
  };
  for (const command of commands) {
    for (const category of staticShellCategories(command)) {
      if (policy[category] !== 'allow') {
        add(category, command);
        continue;
      }
      if (category !== 'download') continue;
      const places = await downloadsOutside(command, place);
      if (places.length === 0) continue;
      add(category, command);
      if (!outside.some((o) => o.command === command)) outside.push({ command, places });
    }
  }

  const reasons: ShellGateReason[] = [];
  for (const [category, list] of details) {
    const state = policy[category];
    if (state === 'allow') {
      // An allowed download that writes outside the job's workspaces asks.
      reasons.push({ category, state: 'ask', details: list, outside });
      continue;
    }
    reasons.push({ category, state, details: list });
  }
  return reasons;
}

/** How the model reads each kind of action in a refusal (never shown to a person). */
const CATEGORY_FOR_MODEL: Record<ShellCategory, string> = {
  inline_code: 'run code written into a command (python -c, node -e and the like)',
  delete_files: 'delete files or discard work',
  install_software: 'install software or packages',
  download: 'download from the internet',
  open_or_send: `open a program or a file on the person's screen, print, or send a message`,
  stop_programs: 'stop other programs or services',
  system_settings: 'change system settings, permissions or disks',
};

/**
 * Where the action goes instead of the shell, for every kind (#667): a tool
 * that does it and asks the person itself. An agent holding a print tool that
 * asks printed through the shell, past that question. Read from the agent's
 * own tool descriptions, never a tool named here: which tools an agent holds
 * is data.
 */
const ASKING_TOOL_REMEDY =
  'if one of your tools does this action and its description says it asks the person ' +
  'first, use that tool: the person decides there.';

/**
 * The refusal the MODEL reads when a kind of action is set to "never".
 * Prescriptive, like the rule refusal: what is forbidden and that it is
 * intentional — otherwise the model retries or works around it.
 */
export function shellChecklistRefusal(never: readonly ShellGateReason[]): string {
  const what = never.map((r) => CATEGORY_FOR_MODEL[r.category]).join('; ');
  return (
    `blocked: the owner does not allow this agent to ${what} through the shell. This is an ` +
    `intentional restriction — do NOT retry it and do NOT work around it via other commands, ` +
    `scripts or sub-agents. Instead, ${ASKING_TOOL_REMEDY} Otherwise report the limitation in your ` +
    `result.`
  );
}

/**
 * What the MODEL reads, after the person's refusal, when the checklist held
 * the command (#667): which kinds held it, and the same remedy as a "never".
 * The person's reason comes first and can rule the action out altogether.
 */
export function shellChecklistDeclined(held: readonly ShellGateReason[]): string {
  const what = held.map((r) => CATEGORY_FOR_MODEL[r.category]).join('; ');
  return (
    `The shell checklist held this command because it would ${what}. Do not run it through ` +
    `the shell again. Unless the person's reason rules the action out: ${ASKING_TOOL_REMEDY}`
  );
}
