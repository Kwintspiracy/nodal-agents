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

import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  downloadWrites,
  isCatastrophicCommand,
  languageOfPath,
  languageOfShebang,
  programDecidedAtRunTime,
  programSources,
  readSource,
  staticShellCategories,
  type ShellCategory,
  type ShellGateReason,
  type ShellHost,
  type ShellPolicy,
  type ShellSourceFinding,
  type ShellUnreadSource,
  type ScriptShell,
  type SourceLanguage,
  type FolderMove,
} from '@nodal-agents/shared';

/** What the gate could read of a file a command runs (#635). */
export type SourceFile =
  | { kind: 'text'; text: string; bytes: number }
  /** An executable file format (ELF, PE, Mach-O): a program, not a script. */
  | { kind: 'executable' }
  /** Neither text in UTF-8 or UTF-16 nor an executable. */
  | { kind: 'binary'; bytes: number }
  | {
      kind: 'unread';
      why: Exclude<ShellUnreadSource['why'], 'decided_at_run_time' | 'not_text' | 'over_budget'>;
    };

/** Where the commands of a call run: what an allowed download is judged against. */
export interface ShellPlace {
  /** The folder the commands start in, canonical; null when it cannot be resolved. */
  cwd: string | null;
  /** The kind of shell the commands run in: what a Windows device name is judged as (#669). */
  host: ShellHost;
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
 * The first bytes of an executable file format: ELF, PE (`MZ`), Mach-O (32
 * and 64 bits, both byte orders) and universal Mach-O (review pass 2 of #683,
 * C1). What the system runs as a program is recognised by its format, never
 * by a NUL byte: cmd and sh run the lines of a script that holds one.
 */
const EXECUTABLE_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];

function isExecutableFormat(head: Uint8Array): boolean {
  return EXECUTABLE_MAGIC.some((magic) => magic.every((b, i) => head[i] === b));
}

/**
 * Read a file a command runs, already known to be inside a workspace: an
 * executable format (whatever its size), text in UTF-8 or UTF-16 (PowerShell's
 * own default), bytes that are neither, or why it cannot be read. Whether
 * bytes that are not text are a program or a source that cannot be read
 * depends on how the file is run, which the caller knows.
 */
export async function readSourceFile(canonicalPath: string): Promise<SourceFile> {
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) return { kind: 'unread', why: 'not_a_file' };
    const handle = await open(canonicalPath, 'r');
    let head: Uint8Array;
    try {
      const buffer = new Uint8Array(8);
      const { bytesRead } = await handle.read(buffer, 0, 8, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (isExecutableFormat(head)) return { kind: 'executable' };
    if (info.size > MAX_SOURCE_BYTES) return { kind: 'unread', why: 'too_large' };
    const bytes = await readFile(canonicalPath);
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return { kind: 'text', text: bytes.subarray(2).toString('utf16le'), bytes: bytes.length };
    let text: string;
    try {
      // A NUL is text: cmd and sh run the lines around it.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'binary', bytes: bytes.length };
    }
    return { kind: 'text', text: text.replace(/^﻿/, ''), bytes: bytes.length };
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
 * Where a file a command names is, from the folder `base` it runs from. A
 * backslash is a folder separator for cmd and PowerShell, which run on Linux
 * too: `.\setup.ps1` names the same file on every OS. The text is judged, not
 * the machine (#669).
 */
function sourcePath(written: string, base: string | null): string | null {
  const path = written.replace(/\\/g, '/');
  if (isAbsolute(path)) return path;
  return base === null ? null : resolve(base, path);
}

/** The key of a script read from a folder, in `ReadBudget.ends`. */
function endKey(path: string, base: string): string {
  const key = `${path}\n${base}`;
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * The folder a line is in at each point: the starting folder, then after each
 * folder move of the line, in order; null once one cannot be read. A script
 * run in the line's own process leaves it where its body ended, as the gate
 * read it (`scripts.ends`), and in a folder not known when it was not read
 * (#717). A word the shell may resolve to a script of the folder moves nothing
 * when the gate found no script there (`scripts.programs`), and the folder is
 * not known after a script found that may not run. A folder kept (`{ save }`:
 * entering a child process, cmd's `setlocal`) comes back with its
 * `{ restore }`; `kept` carries them across a script's lines.
 */
function basesOf(
  dirs: readonly FolderMove[],
  cwd: string | null,
  scripts: ScriptsRead,
  kept: Array<string | null> = [],
): Array<string | null> {
  const bases: Array<string | null> = [cwd];
  let base = cwd;
  for (const move of dirs) {
    if (move === null || typeof move === 'string')
      base = base === null || move === null ? null : resolve(base, move);
    else if ('script' in move) {
      const path = sourcePath(move.script, base);
      if (base === null || path === null) base = null;
      else {
        const key = endKey(path, base);
        if (!scripts.programs.has(key))
          base = move.mayNotRun === true ? null : (scripts.ends.get(key) ?? null);
      }
    } else if ('save' in move) kept.push(base);
    else base = kept.length > 0 ? (kept.pop() ?? null) : null;
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
async function downloadsOutside(
  command: string,
  place: ShellPlace,
  reader: ScriptShell | undefined,
  scripts: ScriptsRead,
): Promise<string[]> {
  const { dirs, targets } = downloadWrites(command, place.host, reader);
  if (targets.length === 0) return [];
  const bases = basesOf(dirs, place.cwd, scripts);
  const outside: string[] = [];
  for (const { path, after } of targets) {
    if (path === null) {
      if (!outside.includes(UNREADABLE_TARGET)) outside.push(UNREADABLE_TARGET);
      continue;
    }
    const from = after === null ? bases : [bases[after] ?? null];
    const candidates = isAbsolute(path)
      ? [resolve(path)]
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
  /** The shell a script's line is written for; the host's for the call's own text. */
  reader: ScriptShell | undefined;
  /** Read from a script's strings: a command only where a string starts. */
  fromStrings: boolean;
}

/** The shell that reads the lines of a source in this language, if it is one. */
const SCRIPT_SHELL: Partial<Record<SourceLanguage, ScriptShell>> = {
  shell: 'sh',
  cmd: 'cmd',
  powershell: 'powershell',
};

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
  /**
   * The folder each shell, cmd or PowerShell script read to its end ends in,
   * by its path and the folder it ran from (`endKey`): where a script run in
   * the line's own process leaves it (#717). One not read is not here.
   */
  ends: Map<string, string | null>;
  /**
   * The words the shell may resolve to a script of the folder (`prepare`,
   * `.\env`) for which none was found there, by the same key: programs, which
   * move no folder (Nodal review of PR #721, P2).
   */
  programs: Set<string>;
  /**
   * The folder the call starts in. A file not found in another one was looked
   * for where only a move took the line, which may have failed: it asks
   * (Nodal review of PR #721, P1).
   */
  start: string | null;
}

/** What the gate learnt of the scripts a call runs in its own process. */
type ScriptsRead = Pick<ReadBudget, 'ends' | 'programs'>;

/** The extensions of a script a shell runs in its own process, among those it tries. */
const IN_PROCESS_SCRIPT = /\.(bat|cmd|ps1)$/i;

/**
 * The file a word the shell may resolve by adding an extension names, looked
 * for in the order the shell tries them; null when there is none, `unknown`
 * when the folder cannot be looked into (outside the job's workspaces).
 */
async function lookFor(
  place: ShellPlace,
  path: string,
  extensions: readonly string[],
): Promise<{ path: string; read: SourceFile } | null | 'unknown'> {
  for (const extension of extensions) {
    const read = await place.readSource(path + extension);
    if (read.kind === 'unread' && read.why === 'not_found') continue;
    if (read.kind === 'unread' && read.why === 'outside_workspaces') return 'unknown';
    return { path: path + extension, read };
  }
  return null;
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
  /**
   * Where `command` itself was read: the file (null for the call's own text),
   * that file's text and the line. Code a line carries (a here-document,
   * `python -c`) is found there, at its own line.
   */
  origin: { label: string | null; text: string; line: number } | null,
  /** The shell that reads `command`: a script's, or the host's (undefined). */
  reader: ScriptShell | undefined,
): Promise<void> {
  const { dirs, sources } = programSources(command, {
    direct: !fromStrings,
    host: place.host,
    reader,
  });
  for (const source of sources) {
    // Read again for each source: a script read before it, in the line's own
    // process, has said by now where it leaves the line (#717).
    const bases = basesOf(dirs, place.cwd, budget);
    const named = source.kind === 'file' ? (source.path ?? command) : command;
    // A word only looked for, past the depth read, is not reported: whether
    // it is a script is not known, and so is the folder after it.
    if (depth > MAX_SOURCE_DEPTH && source.kind === 'file' && source.extensions) continue;
    if (depth > MAX_SOURCE_DEPTH) {
      unread.push({ source: named, why: 'over_budget' });
      continue;
    }
    let text: string;
    let language: SourceLanguage;
    let label: string | null;
    let base: string | null;
    // Where the lines of this source are shown from: the file it is, or the
    // file (or call) its code is written in, from the line it starts on.
    let shown: string;
    let firstLine = 1;
    // Where the end of this script is kept, when it runs in the line's process.
    let endAt: string | null = null;
    if (source.kind === 'code') {
      text = source.code;
      language = source.language;
      // In a file, the code's lines are the file's, from the line it starts
      // on; in the call's own text, the code's own lines.
      label = origin?.label ?? null;
      shown = origin?.text ?? text;
      firstLine = origin === null ? 1 : origin.line + source.line - 1;
      base = bases[source.after] ?? null;
      budget.bytes += text.length;
      if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: named, why: 'over_budget' });
        continue;
      }
    } else {
      base = bases[source.after] ?? null;
      const written = source.path === null ? null : sourcePath(source.path, base);
      if (source.path === null || written === null) {
        unread.push({ source: named, why: 'decided_at_run_time' });
        continue;
      }
      endAt = base === null ? null : endKey(written, base);
      let path = written;
      let file = source.path;
      let looked: SourceFile | null = null;
      if (source.extensions !== undefined) {
        // `prepare` may be `prepare.bat` of the folder (P2): the file the
        // shell would find, in its order; none, or a program, moves nothing.
        const found = await lookFor(place, written, source.extensions);
        if (found === 'unknown') continue;
        if (found === null || !IN_PROCESS_SCRIPT.test(found.path)) {
          if (endAt !== null) budget.programs.add(endAt);
          continue;
        }
        path = found.path;
        file = source.path + found.path.slice(written.length);
        looked = found.read;
      }
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (budget.seen.has(key)) continue;
      budget.seen.add(key);
      if (budget.files >= MAX_SOURCE_FILES || budget.bytes >= MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: file, why: 'over_budget' });
        continue;
      }
      budget.files += 1;
      const read = looked ?? (await place.readSource(path));
      if (read.kind === 'unread') {
        // A file looked for in a folder only a move took the line to: the
        // move may have failed, and the file of the folder the line is still
        // in runs (P1). It is no file that nothing runs.
        if (
          read.why === 'not_found' &&
          !isAbsolute(file.replace(/\\/g, '/')) &&
          base !== null &&
          (budget.start === null || !samePlace(base, budget.start))
        ) {
          unread.push({ source: file, why: 'decided_at_run_time' });
          continue;
        }
        // A bare name not in the folder: the shell takes it from the PATH.
        if (read.why === 'not_found' && source.searched) continue;
        unread.push({ source: file, why: read.why });
        continue;
      }
      // An executable format is a program, judged by its name when the system
      // runs it. Anything else is source: a script the system runs through
      // cmd or sh, or a file an interpreter reads. Source that is not text
      // cannot be read, and says so (review passes 1 and 2 of #683).
      if (read.kind === 'executable') {
        if (!source.executed) unread.push({ source: source.path, why: 'not_text' });
        continue;
      }
      budget.bytes += read.bytes;
      if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: source.path, why: 'over_budget' });
        continue;
      }
      if (read.kind === 'binary') {
        unread.push({ source: source.path, why: 'not_text' });
        continue;
      }
      text = read.text;
      language =
        source.language ??
        (source.extensions ? languageOfPath(path) : null) ??
        languageOfShebang(text) ??
        'shell';
      label = file;
      shown = text;
    }
    const reading = readSource(text, language);
    const lineReader = SCRIPT_SHELL[language];
    // A script runs from the folder its command was in; in a shell script, a
    // `cd` moves the lines after it.
    let cwd = base;
    // The folders kept by cmd's `setlocal`: the end of a batch file restores them.
    const kept: Array<string | null> = [];
    let toTheEnd = true;
    for (const c of reading.commands) {
      if (judged.length >= MAX_JUDGED_COMMANDS) {
        unread.push({ source: label ?? command, why: 'over_budget' });
        toTheEnd = false;
        break;
      }
      const at: ShellPlace = { ...place, cwd };
      const line = firstLine + c.line - 1;
      judged.push({
        call,
        text: c.command,
        place: at,
        found: { source: label, line, text: lineOf(shown, line) },
        reader: lineReader,
        fromStrings: reading.fromStrings,
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
        { label, text: shown, line },
        lineReader,
      );
      if (!reading.fromStrings) {
        const after = basesOf(
          programSources(c.command, { direct: true, host: place.host, reader: lineReader }).dirs,
          cwd,
          budget,
          kept,
        );
        cwd = after[after.length - 1] ?? null;
      }
    }
    // Where a script read to its end leaves the process that runs it, when
    // that process is the line's (`{ script }` moves, #717).
    if (endAt !== null && !reading.fromStrings && toTheEnd)
      budget.ends.set(endAt, kept.length > 0 ? (kept[0] ?? null) : cwd);
  }
}

/**
 * Every command a call runs: its own, and those read in the code they run
 * (#635), each with where it was read. What could not be read is in `unread`,
 * with the commands of the call it belongs to.
 */
async function readCall(
  commands: readonly string[],
  place: ShellPlace,
): Promise<{
  judged: Judged[];
  unread: ShellUnreadSource[];
  unreadCalls: string[];
  scripts: ScriptsRead;
}> {
  const judged: Judged[] = [];
  const unread: ShellUnreadSource[] = [];
  const unreadCalls: string[] = [];
  // One budget for the whole call: a declared proof's commands share it.
  const budget: ReadBudget = {
    files: 0,
    bytes: 0,
    seen: new Set(),
    ends: new Map(),
    programs: new Set(),
    start: place.cwd,
  };
  for (const command of commands) {
    judged.push({
      call: command,
      text: command,
      place,
      found: null,
      reader: undefined,
      fromStrings: false,
    });
    const before = unread.length;
    await readRunCode(command, command, place, false, 1, budget, judged, unread, null, undefined);
    if (unread.length > before) unreadCalls.push(command);
  }
  return { judged, unread, unreadCalls, scripts: budget };
}

/**
 * True when a command the call runs, typed or read in the code it runs, is a
 * machine-wide destroyer (`isCatastrophicCommand`): the hard floor, refused
 * even after approval (review pass 3 of #683: `os.system("reboot")` in a
 * script ran unasked, `os.system("rm -rf /")` was an approvable deletion). A
 * script's string is read where it starts, as everywhere for strings.
 */
export async function callReachesTheFloor(
  commands: readonly string[],
  place: ShellPlace,
): Promise<boolean> {
  const { judged } = await readCall(commands, place);
  return judged.some((j) =>
    isCatastrophicCommand(j.text, j.place.host, j.reader, { atCommandPositions: j.fromStrings }),
  );
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

  const { judged, unread, unreadCalls, scripts } = await readCall(commands, place);

  for (const j of judged) {
    for (const category of staticShellCategories(j.text, j.place.host, j.reader)) {
      if (policy[category] !== 'allow') {
        add(category, j);
        continue;
      }
      // An allowed kind still asks when the text cannot say what it acts on:
      // a program decided at run time (`$c x`, `%X% x`) for inline code, as a
      // target decided at run time for a download (#667, review of PR #682).
      if (category === 'inline_code') {
        if (programDecidedAtRunTime(j.text, j.place.host, j.reader)) add(category, j);
        continue;
      }
      if (category !== 'download') continue;
      const places = await downloadsOutside(j.text, j.place, j.reader, scripts);
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
      // An allowed download that writes outside the job's workspaces asks,
      // saying where; allowed inline code that runs a program decided at run
      // time asks with its commands.
      reasons.push({
        category,
        state: 'ask',
        details: list,
        ...(category === 'download' ? { outside } : {}),
        ...extra,
      });
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
  // A script whose path the text does not say (`python $SCRIPT`) cannot be
  // named ahead, like a program decided at run time (#667): it asks even when
  // inline code is allowed.
  const decided = unread.some((u) => u.why === 'decided_at_run_time');
  if (unread.length > 0 && (policy.inline_code !== 'allow' || decided)) {
    const code = reasons.find((r) => r.category === 'inline_code');
    if (code !== undefined) {
      code.unread = unread;
      for (const c of unreadCalls) if (!code.details.includes(c)) code.details.push(c);
    } else {
      reasons.push({
        category: 'inline_code',
        state: policy.inline_code === 'allow' ? 'ask' : policy.inline_code,
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
