// shell-checklist.ts — judging a shell command against the agent's checklist (#464).
//
// Each command the call will run is read for the kinds of action it performs
// (`staticShellCategories`, packages/shared), and the state the owner gave
// each kind applies. What it returns is FACTS: one reason per kind whose state
// is `ask` or `never`, with the commands that did it. The caller
// (`executeTool`) turns them into a block or an approval, and stores them on
// the approval so the card can show them.
//
// A reading of the text, like Hermes Agent's, and of the code the command runs
// (#635): `python build.py` is judged by what build.py holds, read inside the
// job's workspaces with the same classifier (packages/shared,
// program-sources.ts). It does not keep an agent inside its folders: that
// takes an OS-level sandbox (#628).
//
// One exception to "reading the text only", and it is the definition of an
// allowed download (#614, revue Nodal de la PR #618, P1b): a download runs
// without asking because it lands in the agent's workspace, where a checkpoint
// keeps what it replaces. So the places a download writes (`downloadWrites`)
// are resolved against the command's working folder and the job's workspaces;
// one outside them, or one the text does not name, asks.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  downloadWrites,
  languageOfShebang,
  programSources,
  readSource,
  staticShellCategories,
  type ShellCategory,
  type ShellGateReason,
  type ShellPolicy,
  type ShellSourceFinding,
  type ShellUnreadSource,
  type SourceLanguage,
} from '@nodal-agents/shared';

/** What the gate could read of a file a command runs (#635). */
export type SourceFile =
  /** Text; `nul` when its first bytes hold a NUL, the mark of a program file. */
  | { kind: 'text'; text: string; nul: boolean; bytes: number }
  /** Not text in UTF-8 or UTF-16. */
  | { kind: 'binary'; bytes: number }
  | {
      kind: 'unread';
      why: Exclude<ShellUnreadSource['why'], 'decided_at_run_time' | 'not_text' | 'over_budget'>;
    };

/** Where the commands of a call run: what an allowed download is judged against. */
export interface ShellPlace {
  /** The folder the commands start in, canonical; null when it cannot be resolved. */
  cwd: string | null;
  /** True when an absolute path lies inside one of the job's workspaces. */
  inWorkspace(absolutePath: string): Promise<boolean>;
  /** Where an absolute path really lands, links followed; null when it cannot be told. */
  leadsTo(absolutePath: string): Promise<string | null>;
  /** A file the commands run, read only inside the job's workspaces (#635). */
  readSource(absolutePath: string): Promise<SourceFile>;
}

/**
 * The largest script the gate reads (#635). A script an agent writes is a few
 * kilobytes; past this, it asks rather than reading part of it.
 */
export const MAX_SOURCE_BYTES = 256 * 1024;

/**
 * Read a file a command runs, already known to be inside a workspace: text in
 * UTF-8 or UTF-16 (PowerShell's own default), bytes that are not text, or why
 * it cannot be read. Whether a file that holds a NUL or is not text is a
 * program or a source that cannot be read depends on how it is run, which
 * the caller knows (review of #683, P1).
 */
export async function readSourceFile(canonicalPath: string): Promise<SourceFile> {
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) return { kind: 'unread', why: 'not_a_file' };
    if (info.size > MAX_SOURCE_BYTES) return { kind: 'unread', why: 'too_large' };
    const bytes = await readFile(canonicalPath);
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return {
        kind: 'text',
        text: bytes.subarray(2).toString('utf16le'),
        nul: false,
        bytes: bytes.length,
      };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'binary', bytes: bytes.length };
    }
    return {
      kind: 'text',
      text: text.replace(/^﻿/, ''),
      nul: bytes.subarray(0, 8000).includes(0),
      bytes: bytes.length,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      kind: 'unread',
      why: code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found' : 'unreadable',
    };
  }
}

/** Two absolute paths name the same place (case-insensitive on Windows). */
function samePlace(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** What an unreadable target (a variable, `~`, a sub-shell) is called on the card. */
const UNREADABLE_TARGET = 'a path decided when the command runs';

/**
 * The folder a line is in at each point: the starting folder, then after each
 * `cd` of the line, in order; null once one cannot be read.
 */
function basesOf(dirs: ReadonlyArray<string | null>, cwd: string | null): Array<string | null> {
  const bases: Array<string | null> = [cwd];
  let base = cwd;
  for (const dir of dirs) {
    base = base === null || dir === null ? null : resolve(base, dir);
    bases.push(base);
  }
  return bases;
}

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
  const bases = basesOf(dirs, place.cwd);
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

/**
 * One text the checklist judges: a command of the call, or a command read in
 * the code it runs (#635), with the folder it runs from and where it was found.
 */
interface Judged {
  /** The command of the call it belongs to: what the card's details list. */
  call: string;
  text: string;
  place: ShellPlace;
  found: ShellSourceFinding | null;
}

/**
 * What the gate reads for one call, at most (review of #683, P2): how deep
 * scripts run by scripts are followed, how many files and bytes are read, how
 * many commands are kept to judge. A runaway tree of scripts must not stall
 * the turn before anyone is asked. What lies past it is not dropped: it is
 * `unread` (`over_budget`), code nobody read ahead, under `inline_code`.
 */
export const MAX_SOURCE_DEPTH = 3;
export const MAX_SOURCE_FILES = 50;
export const MAX_SOURCE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_JUDGED_COMMANDS = 10_000;

/** What one call has read so far, against the limits above. */
interface ReadBudget {
  files: number;
  bytes: number;
  seen: Set<string>;
}

/** The line `line` (1-based) of `text`, as the card shows it. */
function lineOf(text: string, line: number): string {
  const s = (text.split(/\r?\n/)[line - 1] ?? '').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * The commands read in the code `command` runs (#635): the files it hands to
 * an interpreter or runs directly, and the code written into it, followed
 * into the scripts those run in turn. A file that cannot be read, or lies past
 * the reading budget, is reported in `unread`; a file the system runs itself
 * that is not text is a program, judged by its name like any other.
 */
async function readRunCode(
  call: string,
  command: string,
  place: ShellPlace,
  fromStrings: boolean,
  depth: number,
  budget: ReadBudget,
  judged: Judged[],
  unread: ShellUnreadSource[],
): Promise<void> {
  const { dirs, sources } = programSources(command, { direct: !fromStrings });
  const bases = basesOf(dirs, place.cwd);
  for (const source of sources) {
    const named = source.kind === 'file' ? (source.path ?? command) : command;
    if (depth > MAX_SOURCE_DEPTH) {
      unread.push({ source: named, why: 'over_budget' });
      continue;
    }
    let text: string;
    let language: SourceLanguage;
    let label: string | null;
    let base: string | null;
    if (source.kind === 'code') {
      text = source.code;
      language = source.language;
      label = null;
      base = bases[source.after] ?? null;
    } else {
      base = bases[source.after] ?? null;
      // `.\setup.ps1` names the same file on every OS: a backslash in a path
      // is a folder separator for cmd and PowerShell, which run on Linux too.
      // The text is judged, not the machine (#669).
      const written = source.path?.replace(/\\/g, '/') ?? null;
      if (written === null || source.path === null || (base === null && !isAbsolute(written))) {
        unread.push({ source: named, why: 'decided_at_run_time' });
        continue;
      }
      const path = isAbsolute(written) ? written : resolve(base ?? '', written);
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (budget.seen.has(key)) continue;
      budget.seen.add(key);
      if (budget.files >= MAX_SOURCE_FILES || budget.bytes >= MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: source.path, why: 'over_budget' });
        continue;
      }
      budget.files += 1;
      const read = await place.readSource(path);
      if (read.kind === 'unread') {
        // A bare name not in the folder: the shell takes it from the PATH.
        if (read.why === 'not_found' && source.searched) continue;
        unread.push({ source: source.path, why: read.why });
        continue;
      }
      budget.bytes += read.bytes;
      if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: source.path, why: 'over_budget' });
        continue;
      }
      // Run by the system, bytes that are not text (or hold a NUL) are a
      // program. Read by an interpreter, they are source: a NUL does not stop
      // it from being read, bytes that are not text do (review of #683, P1).
      if (source.executed && (read.kind === 'binary' || read.nul)) continue;
      if (read.kind === 'binary') {
        unread.push({ source: source.path, why: 'not_text' });
        continue;
      }
      text = read.text;
      language = source.language ?? languageOfShebang(text) ?? 'shell';
      label = source.path;
    }
    const reading = readSource(text, language);
    // A script runs from the folder its command was in; in a shell script, a
    // `cd` moves the lines after it.
    let cwd = base;
    for (const c of reading.commands) {
      if (judged.length >= MAX_JUDGED_COMMANDS) {
        unread.push({ source: label ?? command, why: 'over_budget' });
        break;
      }
      const at: ShellPlace = { ...place, cwd };
      judged.push({
        call,
        text: c.command,
        place: at,
        found: { source: label, line: c.line, text: lineOf(text, c.line) },
      });
      await readRunCode(
        call,
        c.command,
        at,
        reading.fromStrings,
        depth + 1,
        budget,
        judged,
        unread,
      );
      if (!reading.fromStrings) {
        const after = basesOf(programSources(c.command).dirs, cwd);
        cwd = after[after.length - 1] ?? null;
      }
    }
  }
}

/** Judge `commands` (the ones this call will run, from `place`) against `policy`. */
export async function judgeShellChecklist(
  commands: readonly string[],
  policy: ShellPolicy,
  place: ShellPlace,
): Promise<ShellGateReason[]> {
  const details = new Map<ShellCategory, string[]>();
  const found = new Map<ShellCategory, ShellSourceFinding[]>();
  // Each command's own places outside, attached to it (revue passe 2).
  const outside: NonNullable<ShellGateReason['outside']> = [];
  const unread: ShellUnreadSource[] = [];
  const unreadCalls: string[] = [];
  const add = (category: ShellCategory, j: Judged): void => {
    const list = details.get(category) ?? [];
    if (!list.includes(j.call)) list.push(j.call);
    details.set(category, list);
    if (j.found === null) return;
    const f = j.found;
    const where = found.get(category) ?? [];
    if (!where.some((w) => w.source === f.source && w.line === f.line)) where.push(f);
    found.set(category, where);
  };

  const judged: Judged[] = [];
  // One budget for the whole call: a declared proof's commands share it.
  const budget: ReadBudget = { files: 0, bytes: 0, seen: new Set() };
  for (const command of commands) {
    judged.push({ call: command, text: command, place, found: null });
    const before = unread.length;
    await readRunCode(command, command, place, false, 1, budget, judged, unread);
    if (unread.length > before) unreadCalls.push(command);
  }

  for (const j of judged) {
    for (const category of staticShellCategories(j.text)) {
      if (policy[category] !== 'allow') {
        add(category, j);
        continue;
      }
      if (category !== 'download') continue;
      const places = await downloadsOutside(j.text, j.place);
      if (places.length === 0) continue;
      add(category, j);
      const entry = outside.find((o) => o.command === j.call);
      if (entry === undefined) outside.push({ command: j.call, places });
      else for (const p of places) if (!entry.places.includes(p)) entry.places.push(p);
    }
  }

  const reasons: ShellGateReason[] = [];
  for (const [category, list] of details) {
    const state = policy[category];
    const where = found.get(category);
    const extra = where !== undefined ? { found: where } : {};
    if (state === 'allow') {
      // An allowed download that writes outside the job's workspaces asks.
      reasons.push({ category, state: 'ask', details: list, outside, ...extra });
      continue;
    }
    reasons.push({ category, state, details: list, ...extra });
  }

  // A script that could not be read is code nobody read ahead (#635), the
  // kind `inline_code` names: `curl … | bash`, or a script downloaded and run
  // in the same line, which does not exist yet when the line is judged. Its
  // state applies, never a guess about what the script would do: allowed by
  // default (the owner's decision of 29/09, #618), asked or refused when the
  // owner set it so, and the card then names the file and why.
  if (unread.length > 0 && policy.inline_code !== 'allow') {
    const code = reasons.find((r) => r.category === 'inline_code');
    if (code !== undefined) {
      code.unread = unread;
      for (const c of unreadCalls) if (!code.details.includes(c)) code.details.push(c);
    } else {
      reasons.push({
        category: 'inline_code',
        state: policy.inline_code,
        details: unreadCalls,
        unread,
      });
    }
  }
  return reasons;
}

/** How the model reads each kind of action in a refusal (never shown to a person). */
const CATEGORY_FOR_MODEL: Record<ShellCategory, string> = {
  inline_code: 'run code written into a command (python -c, node -e and the like)',
  delete_files: 'delete files or discard work',
  install_software: 'install software or packages',
  download: 'download from the internet',
  stop_programs: 'stop other programs or services',
  system_settings: 'change system settings, permissions or disks',
};

/**
 * The refusal the MODEL reads when a kind of action is set to "never".
 * Prescriptive, like the rule refusal: what is forbidden and that it is
 * intentional — otherwise the model retries or works around it.
 */
export function shellChecklistRefusal(never: readonly ShellGateReason[]): string {
  const what = never.map((r) => CATEGORY_FOR_MODEL[r.category]).join('; ');
  return (
    `blocked: the owner does not allow this agent to ${what}. This is an intentional ` +
    `restriction — do NOT retry it and do NOT work around it via other commands, scripts, ` +
    `tools or sub-agents. Use your allowed tools, or report the limitation in your result.`
  );
}
