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
 * Where a path a command names is, from the folder `base` it runs from: a
 * script it runs, a folder it moves into, a file it downloads to; null for a
 * relative path from a folder not known. A backslash is a folder separator
 * for cmd and PowerShell, which run on Linux too: `.\setup.ps1` and
 * `..\evil.zip` name the same place on every OS. The text is judged, not the
 * machine (#669); every path of the gate goes through here (#717: folder moves
 * and download targets resolved with the machine's `path` left `..\evil.zip`
 * inside the workspace on Linux).
 */
function namedPath(written: string, base: string): string;
function namedPath(written: string, base: string | null): string | null;
function namedPath(written: string, base: string | null): string | null {
  const path = written.replace(/\\/g, '/');
  if (isAbsolute(path)) return resolve(path);
  return base === null ? null : resolve(base, path);
}

/** The key of a script read from a folder, in `ReadBudget.ends`. */
function endKey(path: string, base: string): string {
  const key = `${path}\n${base}`;
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * The folders a line may be in at one point (Nodal review of PR #721, pass
 * 3): a `cd` may fail, a move may not run, and the gate never decides which
 * from what it sees on the disk when it judges (the line may make or remove a
 * folder before its `cd`). Null when not known: a script not read, a folder
 * the text does not say, more than `MAX_FOLDERS` of them.
 */
type Folders = readonly string[] | null;

/** How many folders a line may be in before where it is counts as not known. */
export const MAX_FOLDERS = 8;

/** `list` as a set of folders: each once, null past `MAX_FOLDERS` or when one is not known. */
function foldersOf(list: ReadonlyArray<string | null>): Folders {
  const out: string[] = [];
  for (const folder of list) {
    if (folder === null) return null;
    if (!out.some((f) => samePlace(f, folder))) out.push(folder);
  }
  return out.length > MAX_FOLDERS ? null : out;
}

/** Each folder of `from`, gone through `step`; null when one leads where the gate cannot say. */
function eachOf(
  from: Folders,
  step: (folder: string) => ReadonlyArray<string | null> | null,
): Folders {
  if (from === null) return null;
  const out: Array<string | null> = [];
  for (const folder of from) {
    const to = step(folder);
    if (to === null) return null;
    out.push(...to);
  }
  return foldersOf(out);
}

/**
 * The folders a line may be in at each point: the starting ones, then after
 * each folder move of the line, in order (#717). A move is made for what
 * follows it in its own `&&` chain, which runs only if it was: there, the line
 * is in the folder entered from each one it was in. Past that chain, the move
 * may have failed (a `cd` into a missing folder, whatever the disk holds when
 * the gate judges) or not run: the line is in the folders it was in before it
 * or in those it entered (`{ unsure }`). A script run in the line's own
 * process leaves it where its body ended, from each folder it ran from, as
 * the gate read it (`scripts.ends`), and where it cannot say when it was not
 * read. A word the shell may resolve to a script of the folder moves nothing
 * where the gate found no script (`scripts.programs`). A folder kept
 * (`{ save }`: entering a child process, cmd's `setlocal`) comes back with its
 * `{ restore }`; `kept` carries them across a script's lines.
 */
function basesOf(
  dirs: readonly FolderMove[],
  start: Folders,
  scripts: ScriptsRead,
  kept: Folders[] = [],
): Folders[] {
  const bases: Folders[] = [start];
  let base = start;
  for (const move of dirs) {
    if (move === null) base = null;
    else if (typeof move === 'string') base = eachOf(base, (folder) => [namedPath(move, folder)]);
    else if ('script' in move)
      base = eachOf(base, (folder) => {
        const key = endKey(namedPath(move.script, folder), folder);
        if (move.extensions !== undefined && scripts.programs.has(key)) return [folder];
        return scripts.ends.get(key) ?? null;
      });
    else if ('unsure' in move) {
      const before = bases[move.unsure] ?? null;
      base = before === null || base === null ? null : foldersOf([...before, ...base]);
    } else if ('save' in move) kept.push(base);
    else base = kept.length > 0 ? (kept.pop() ?? null) : null;
    bases.push(base);
  }
  return bases;
}

/**
 * The places `command` would download to that are not inside a workspace of
 * the job, as written. A relative target is judged from every folder the line
 * may be in when it runs (`basesOf`): the starting folder, then each `cd` that
 * comes BEFORE it (revue passe 2 : un `cd` écrit après ne la déplace pas). A
 * redirection, whose place in the line is not known, is judged from every
 * folder of it.
 */
async function downloadsOutside(
  command: string,
  from: Folders,
  place: ShellPlace,
  reader: ScriptShell | undefined,
  scripts: ScriptsRead,
): Promise<string[]> {
  const { dirs, targets } = downloadWrites(command, place.host, reader);
  if (targets.length === 0) return [];
  const bases = basesOf(dirs, from, scripts);
  const outside: string[] = [];
  for (const { path, after } of targets) {
    if (path === null) {
      if (!outside.includes(UNREADABLE_TARGET)) outside.push(UNREADABLE_TARGET);
      continue;
    }
    const folders = after === null ? bases : [bases[after] ?? null];
    const absolute = namedPath(path, null);
    const candidates =
      absolute !== null
        ? [absolute]
        : folders.flatMap((f) => (f === null ? [null] : f.map((b) => namedPath(path, b))));
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
 * the code it runs (#635), with the folders it may run from and where it was
 * found.
 */
interface Judged {
  /** The command of the call it belongs to: what the card's details list. */
  call: string;
  text: string;
  place: ShellPlace;
  /** The folders it may run from (`basesOf`). */
  from: Folders;
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
   * The folders each shell, cmd or PowerShell script read to its end may end
   * in, by its path and a folder it ran from (`endKey`): where a script run in
   * the line's own process leaves it (#717). One not read is not here.
   */
  ends: Map<string, Folders>;
  /**
   * The words the shell may resolve to a script of the folder (`prepare`,
   * `.\env`) for which none was found there, by the same key: programs, which
   * move no folder (Nodal review of PR #721, P2).
   */
  programs: Set<string>;
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

/** What one call reads, and what it goes on reading into: shared by every level of `readRunCode`. */
interface Reading {
  call: string;
  place: ShellPlace;
  budget: ReadBudget;
  judged: Judged[];
  unread: ShellUnreadSource[];
}

/**
 * The commands read in the code `command` runs (#635): the files it hands to
 * an interpreter or runs directly, and the code written into it, followed
 * into the scripts those run in turn. A file that cannot be read, or lies past
 * the reading budget, is reported in `unread`; a file the system runs itself
 * that is not text is a program, judged by its name like any other. A file
 * named by a relative path is looked for from every folder the line may be in
 * (`basesOf`), and each one found is read.
 */
async function readRunCode(
  r: Reading,
  command: string,
  /** The folders `command` may run from. */
  from: Folders,
  fromStrings: boolean,
  depth: number,
  /**
   * Where `command` itself was read: the file (null for the call's own text),
   * that file's text and the line. Code a line carries (a here-document,
   * `python -c`) is found there, at its own line.
   */
  origin: { label: string | null; text: string; line: number } | null,
  /** The shell that reads `command`: a script's, or the host's (undefined). */
  reader: ScriptShell | undefined,
): Promise<void> {
  const { place, budget, unread } = r;
  const { dirs, sources } = programSources(command, {
    direct: !fromStrings,
    host: place.host,
    reader,
  });
  for (const source of sources) {
    // Read again for each source: a script read before it, in the line's own
    // process, has said by now where it leaves the line (#717).
    const at = basesOf(dirs, from, budget)[source.after] ?? null;
    const named = source.kind === 'file' ? (source.path ?? command) : command;
    // A word only looked for, past the depth read, is not reported: whether
    // it is a script is not known, and so is the folder after it.
    if (depth > MAX_SOURCE_DEPTH && source.kind === 'file' && source.extensions) continue;
    if (depth > MAX_SOURCE_DEPTH) {
      unread.push({ source: named, why: 'over_budget' });
      continue;
    }
    if (source.kind === 'code') {
      budget.bytes += source.code.length;
      if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: named, why: 'over_budget' });
        continue;
      }
      // In a file, the code's lines are the file's, from the line it starts
      // on; in the call's own text, the code's own lines.
      await readBody(r, {
        text: source.code,
        language: source.language,
        label: origin?.label ?? null,
        shown: origin?.text ?? source.code,
        firstLine: origin === null ? 1 : origin.line + source.line - 1,
        from: at,
        ends: [],
        depth,
        command,
      });
      continue;
    }
    if (source.path === null) {
      unread.push({ source: named, why: 'decided_at_run_time' });
      continue;
    }
    // The file each folder the line may be in names, and the folders it is
    // named from (one file for an absolute path); none where it is not known.
    const files = new Map<string, { path: string; from: string[] }>();
    const absolute = namedPath(source.path, null);
    if (absolute !== null) {
      files.set(absolute, { path: absolute, from: at === null ? [] : [...at] });
    } else if (at === null) {
      // In a folder not known, a word the shell may resolve to a script of it
      // is one nobody read too (pass 3).
      unread.push({ source: named, why: 'decided_at_run_time' });
      continue;
    } else
      for (const folder of at) {
        const path = namedPath(source.path, folder);
        const key = process.platform === 'win32' ? path.toLowerCase() : path;
        const entry = files.get(key) ?? { path, from: [] };
        entry.from.push(folder);
        files.set(key, entry);
      }
    const several = files.size > 1;
    let foundOne = false;
    let missing = 0;
    for (const { path: written, from: folders } of files.values()) {
      const endsAt = folders.map((f) => endKey(written, f));
      let path = written;
      let file = source.path;
      let looked: SourceFile | null = null;
      if (source.extensions !== undefined) {
        // `prepare` may be `prepare.bat` of the folder (P2): the file the
        // shell would find, in its order; none, or a program, moves nothing.
        const found = await lookFor(place, written, source.extensions);
        // A folder the gate cannot look into (outside the workspaces): what
        // the word runs there is not known, as in a folder not known (pass 4).
        if (found === 'unknown') {
          unread.push({ source: source.path, why: 'decided_at_run_time' });
          continue;
        }
        if (found === null || !IN_PROCESS_SCRIPT.test(found.path)) {
          for (const key of endsAt) budget.programs.add(key);
          continue;
        }
        path = found.path;
        file = source.path + found.path.slice(written.length);
        looked = found.read;
      }
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (budget.seen.has(key)) {
        foundOne = true;
        continue;
      }
      budget.seen.add(key);
      if (budget.files >= MAX_SOURCE_FILES || budget.bytes >= MAX_SOURCE_TOTAL_BYTES) {
        unread.push({ source: file, why: 'over_budget' });
        continue;
      }
      budget.files += 1;
      const read = looked ?? (await place.readSource(path));
      if (read.kind === 'unread' && read.why === 'not_found') {
        missing += 1;
        continue;
      }
      foundOne = true;
      if (read.kind === 'unread') {
        // Of several files, the one that runs is decided when the line runs:
        // one that cannot be read asks (pass 3).
        unread.push({ source: file, why: several ? 'decided_at_run_time' : read.why });
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
      await readBody(r, {
        text: read.text,
        language:
          source.language ??
          (source.extensions ? languageOfPath(path) : null) ??
          languageOfShebang(read.text) ??
          'shell',
        label: file,
        shown: read.text,
        firstLine: 1,
        from: folders.length > 0 ? folders : null,
        ends: endsAt,
        depth,
        command,
      });
    }
    // Found in no folder: nothing runs, as a file the starting folder does
    // not hold; a bare name not there is a program of the PATH.
    if (!foundOne && missing > 0 && !source.searched)
      unread.push({ source: source.path, why: 'not_found' });
  }
}

/**
 * Judge the lines of a source, each from the folders the lines before it
 * leave the script in, and keep where it ends under `ends` (#717): in a shell
 * script, a `cd` moves the lines after it.
 */
async function readBody(
  r: Reading,
  s: {
    text: string;
    language: SourceLanguage;
    label: string | null;
    shown: string;
    firstLine: number;
    /** The folders the script starts in: those its command may run from. */
    from: Folders;
    /** Where to keep the folders it ends in, read to its end. */
    ends: readonly string[];
    depth: number;
    command: string;
  },
): Promise<void> {
  const { place, budget, judged, unread } = r;
  const reading = readSource(s.text, s.language);
  const lineReader = SCRIPT_SHELL[s.language];
  let cwd = s.from;
  // The folders kept by cmd's `setlocal`: the end of a batch file restores them.
  const kept: Folders[] = [];
  let toTheEnd = true;
  for (const c of reading.commands) {
    if (judged.length >= MAX_JUDGED_COMMANDS) {
      unread.push({ source: s.label ?? s.command, why: 'over_budget' });
      toTheEnd = false;
      break;
    }
    const line = s.firstLine + c.line - 1;
    judged.push({
      call: r.call,
      text: c.command,
      place,
      from: cwd,
      found: { source: s.label, line, text: lineOf(s.shown, line) },
      reader: lineReader,
      fromStrings: reading.fromStrings,
    });
    await readRunCode(
      r,
      c.command,
      cwd,
      reading.fromStrings,
      s.depth + 1,
      { label: s.label, text: s.shown, line },
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
  if (!reading.fromStrings && toTheEnd)
    for (const key of s.ends) budget.ends.set(key, kept.length > 0 ? (kept[0] ?? null) : cwd);
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
  };
  const from: Folders = place.cwd === null ? null : [place.cwd];
  for (const command of commands) {
    judged.push({
      call: command,
      text: command,
      place,
      from,
      found: null,
      reader: undefined,
      fromStrings: false,
    });
    const before = unread.length;
    await readRunCode(
      { call: command, place, budget, judged, unread },
      command,
      from,
      false,
      1,
      null,
      undefined,
    );
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
      const places = await downloadsOutside(j.text, j.from, j.place, j.reader, scripts);
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
