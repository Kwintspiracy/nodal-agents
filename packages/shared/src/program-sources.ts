// program-sources.ts — the code a command hands to an interpreter, and the
// commands that code runs (#635).
//
// The checklist (shell-checklist.ts) files a command by what its TEXT shows.
// `python build.py` shows an interpreter and a file name: what the file does
// is not in the text. Run 074e7161 (bench #634) had an agent write a script
// that pip-installs openpyxl and run it with `python …`: installing software
// went through without the question the owner set.
//
// The rule, for every agent, runtime and OS: a command that runs a program's
// SOURCE is also judged by that source, with the same classifier.
//
// - Where a source is: the file an interpreter is given (`python x.py`,
//   `node x.js`, `bash x.sh`, `powershell -File x.ps1`, `perl`, `ruby`, `php`,
//   `tsx`, `ts-node`, `deno run`, `bun`), a file run directly (`./x.sh`,
//   `x.bat`, `scripts/run`, `source x.sh`), and the code written into the
//   command for an interpreter whose code is not a command line (`python -c`,
//   `node -e`, `ruby -e`, `php -r`). `bash -c` and `powershell -Command` are
//   command lines already read by `commandUnits`.
// - How it is read: a shell, cmd or PowerShell source line by line, as
//   commands. Any other language by its STRINGS: each string literal is read
//   as the start of a command, with the strings that follow it in the same
//   statement as its arguments (`["pip", "install", "x"]`, `os.system("rm -rf
//   build")`, `execSync(\`npm i ${p}\`)`). An argument that is not a literal is
//   a value decided when the script runs, written `$`, so a download target
//   built from a variable asks as on a command line. Comments are not read.
//   Plus the installs a language does through its own API rather than a
//   program (`pip.main([...])`, `Gem.install`).
//
// A string is read whether the script runs it or prints it: telling one from
// the other takes following values through the code. `print("pip install
// openpyxl")` asks once too often; the opposite error is this ticket.
//
// A file the gate cannot read (outside the job's workspaces, not there yet,
// too large, named by a variable) is code nobody read ahead, the kind
// `inline_code` names, under its state (packages/tools, shell-checklist.ts).
//
// What this reading cannot see is said plainly: code fetched or decoded at
// run time, a file written by the script and then run, what a module the
// script imports does, a command assembled character by character, what a
// language does through its own functions (`os.remove`, `fs.rmSync`,
// `urllib`). Bounding what a process does is an OS sandbox's job (#628); this
// is a net.
//
// Pure: no filesystem (the gate in packages/tools reads the files).

import {
  changeDirOf,
  commandUnitsAsWritten,
  interpreterKind,
  isInlineEvalFlag,
  readablePath,
  shellCommandIndex,
} from './catastrophic-command';

/** The languages a source is read in. */
export type SourceLanguage =
  | 'shell'
  | 'cmd'
  | 'powershell'
  | 'python'
  | 'javascript'
  | 'ruby'
  | 'perl'
  | 'php';

/** Code a command runs: a file it names, or code written into it. */
export type ProgramSource =
  | {
      kind: 'file';
      /** As written; null when the shell decides it at run time (`$F`, `~/x`). */
      path: string | null;
      /** Null when the file says it (a shebang, or binary: then it is a program). */
      language: SourceLanguage | null;
      /** How many of `dirs` come before it in the line (see `downloadWrites`). */
      after: number;
      /**
       * A bare name run directly (`build.bat`, `deploy.sh`): when no such file
       * is in the folder the command runs in, the shell takes it from the PATH
       * (`npm.cmd`), and it is a program like any other, judged by its name.
       */
      searched: boolean;
    }
  | { kind: 'code'; code: string; language: SourceLanguage; after: number };

export interface ProgramSources {
  /** The folders the line moves into, in order (null when unreadable). */
  dirs: Array<string | null>;
  sources: ProgramSource[];
}

const EXTENSION_LANGUAGE: Record<string, SourceLanguage> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  bat: 'cmd',
  cmd: 'cmd',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyw: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  rb: 'ruby',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
};

/** The language a file name says, by its extension. */
export function languageOfPath(path: string): SourceLanguage | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path.split(/[\\/]/).pop() ?? '');
  return m ? (EXTENSION_LANGUAGE[(m[1] ?? '').toLowerCase()] ?? null) : null;
}

/** The language a `#!` line names, or null. */
export function languageOfShebang(text: string): SourceLanguage | null {
  const first = /^#!\s*(.+)$/.exec(text.split(/\r?\n/, 1)[0] ?? '');
  if (!first) return null;
  const words = (first[1] ?? '').trim().split(/\s+/);
  const base = (w: string): string => (w.split('/').pop() ?? '').toLowerCase();
  // `#!/usr/bin/env -S node --flag`: the program is env's first operand.
  const program =
    base(words[0] ?? '') === 'env'
      ? (words.slice(1).find((w) => !w.startsWith('-') && !w.includes('=')) ?? '')
      : (words[0] ?? '');
  return interpreterLanguage(base(program));
}

/** The language of an interpreter's code, by its program name. */
function interpreterLanguage(program: string): SourceLanguage | null {
  switch (interpreterKind(program)) {
    case 'python':
      return 'python';
    case 'node':
      return 'javascript';
    case 'perl':
      return 'perl';
    case 'ruby':
      return 'ruby';
    case 'php':
      return 'php';
    case 'shell':
      return 'shell';
    case 'powershell':
      return 'powershell';
    default:
      break;
  }
  if (['tsx', 'ts-node', 'ts-node-esm', 'deno', 'bun'].includes(program)) return 'javascript';
  if (program === 'fish') return 'shell';
  return null;
}

/** Options of an interpreter that take the next word as their value. */
const VALUE_OPTIONS: Record<SourceLanguage, ReadonlySet<string>> = {
  python: new Set(['-w', '-x', '--check-hash-based-pycs']),
  javascript: new Set([
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '-c',
    '--conditions',
    '--input-type',
    '--title',
    '--tsconfig',
    '--project',
  ]),
  perl: new Set(['-i', '-m', '-x']),
  ruby: new Set(['-i', '-r', '-c', '-x']),
  php: new Set(['-c', '-d', '-z']),
  shell: new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']),
  powershell: new Set([
    '-executionpolicy',
    '-ep',
    '-ex',
    '-exec',
    '-windowstyle',
    '-w',
    '-version',
    '-v',
    '-inputformat',
    '-if',
    '-outputformat',
    '-of',
    '-o',
    '-configurationname',
    '-workingdirectory',
    '-wd',
    '-psconsolefile',
    '-custompipename',
    '-settingsfile',
  ]),
  cmd: new Set(),
};

/** The first word of `args` that is not an option (or an option's value). */
function firstOperand(args: readonly string[], language: SourceLanguage): number {
  const takesValue = VALUE_OPTIONS[language];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') return i + 1 < args.length ? i + 1 : -1;
    if (a.startsWith('-') && a !== '-') {
      if (!a.includes('=') && takesValue.has(language === 'shell' ? a : a.toLowerCase())) i++;
      continue;
    }
    if (language === 'shell' && a.startsWith('+')) {
      if (takesValue.has(a)) i++;
      continue;
    }
    return a === '-' ? -1 : i;
  }
  return -1;
}

/** The program word of a unit runs a file (`./x.sh`, `x.bat`, `scripts/run`). */
function directFile(head: string): boolean {
  if (languageOfPath(head) !== null) return true;
  return /[\\/]/.test(head) && !/^([A-Za-z]:[\\/]|[\\/~]|\$)/.test(head);
}

/** What one command unit runs as source, with `head` its program word as written. */
function unitSources(
  unit: readonly string[],
  head: string,
  after: number,
  direct: boolean,
): ProgramSource[] {
  const program = unit[0] ?? '';
  const args = unit.slice(1);
  const file = (
    path: string,
    language: SourceLanguage | null,
    searched = false,
  ): ProgramSource => ({
    kind: 'file',
    path: readablePath(path),
    language,
    after,
    searched,
  });
  const bare = (path: string): boolean => !/[\\/]/.test(path);
  const language = interpreterLanguage(program);
  if (language === null) {
    if (!direct) return [];
    // `source x.sh`, `. x.ps1`: a file run by the shell itself. (cmd's
    // `call x.bat` is read as `x.bat`, `call` being a pass-through leader.)
    if (program === 'source' || program === '.') {
      const target = args[0];
      if (target === undefined) return [];
      return [file(target, languageOfPath(target) ?? 'shell', bare(target))];
    }
    return directFile(head) ? [file(head, languageOfPath(head), bare(head))] : [];
  }
  const lower = args.map((a) => a.toLowerCase());
  switch (language) {
    case 'shell': {
      // `bash -c "…"` is a command line `commandUnits` already reads.
      if (shellCommandIndex(args) >= 0) return [];
      const i = firstOperand(args, 'shell');
      return i >= 0 ? [file(args[i] ?? '', languageOfPath(args[i] ?? '') ?? 'shell')] : [];
    }
    case 'powershell': {
      // `-Command` is read by `commandUnits`; `-EncodedCommand` is not readable here.
      if (lower.some((a) => /^-(c|com\w*|e|ec|enc\w*)$/.test(a))) return [];
      const f = lower.findIndex((a) => a === '-file' || a === '-f');
      if (f >= 0) return args[f + 1] !== undefined ? [file(args[f + 1] ?? '', 'powershell')] : [];
      const i = firstOperand(args, 'powershell');
      if (i < 0) return [];
      // A first word that is not a script is a command (Windows PowerShell).
      return languageOfPath(args[i] ?? '') === 'powershell'
        ? [file(args[i] ?? '', 'powershell')]
        : [{ kind: 'code', code: args.slice(i).join(' '), language: 'powershell', after }];
    }
    default: {
      const kind = interpreterKind(program);
      // `python -c CODE`, `node -e CODE`, `ruby -e CODE`, `php -r CODE`.
      if (kind !== null) {
        const e = lower.findIndex((a) => isInlineEvalFlag(kind, a));
        if (e >= 0) {
          const code = args[e + 1];
          return code === undefined ? [] : [{ kind: 'code', code, language, after }];
        }
      }
      // `python -m mod` runs a module, read as its own unit by `commandUnits`.
      if (kind === 'python' && lower.includes('-m')) return [];
      if (program === 'php') {
        const f = lower.indexOf('-f');
        if (f >= 0) return args[f + 1] !== undefined ? [file(args[f + 1] ?? '', 'php')] : [];
      }
      let rest = args;
      if (program === 'deno') {
        if (lower[0] === 'eval')
          return args[1] !== undefined
            ? [{ kind: 'code', code: args[1] ?? '', language, after }]
            : [];
        if (lower[0] !== 'run') return [];
        rest = args.slice(1);
      }
      if (program === 'bun') {
        if (lower[0] === 'run') rest = args.slice(1);
        else if (lower[0] === '-e' || lower[0] === '--eval')
          return args[1] !== undefined
            ? [{ kind: 'code', code: args[1] ?? '', language, after }]
            : [];
      }
      const i = firstOperand(rest, language);
      if (i < 0) return [];
      const target = rest[i] ?? '';
      // `bun install`, `bun x`: a subcommand, not a file.
      if (program === 'bun' && languageOfPath(target) === null && !/[\\/]/.test(target)) return [];
      return [file(target, language)];
    }
  }
}

/**
 * The sources a command line runs, and the folders it moves into first.
 * `direct: false` reads only an interpreter given a file or code: for the
 * strings of a script, where a word that names a file is data far more often
 * than a program (`open("a.py")`).
 */
export function programSources(
  cmd: string,
  opts: { direct: boolean } = { direct: true },
): ProgramSources {
  const out: ProgramSources = { dirs: [], sources: [] };
  if (typeof cmd !== 'string' || cmd.trim() === '') return out;
  for (const { unit, head } of commandUnitsAsWritten(cmd)) {
    const dir = changeDirOf(unit);
    if (dir !== undefined) {
      out.dirs.push(dir);
      continue;
    }
    out.sources.push(...unitSources(unit, head, out.dirs.length, opts.direct));
  }
  return out;
}

// ─── Reading a source ────────────────────────────────────────────────────────

/** One command read in a source: where it is, what is judged, what is shown. */
export interface SourceCommand {
  /** 1-based line of the source where the command starts. */
  line: number;
  /** The command, as the checklist judges it. */
  command: string;
}

export interface SourceReading {
  commands: SourceCommand[];
  /**
   * For a shell, cmd or PowerShell source: its commands as one text, in order,
   * so a `cd` on one line moves the downloads of the next (`downloadWrites`).
   * Null for any other language.
   */
  shellText: string | null;
  /**
   * The language of strings read: a command read inside one is never a file
   * run directly (see `programSources`).
   */
  fromStrings: boolean;
}

/** How many words after a string are read as its arguments. */
const MAX_ARGUMENT_WORDS = 16;

/** Read `text`, written in `language`, for the commands it runs. */
export function readSource(text: string, language: SourceLanguage): SourceReading {
  if (language === 'shell' || language === 'cmd' || language === 'powershell') {
    const commands = shellLines(text, language);
    return {
      commands,
      shellText: commands.map((c) => c.command).join('\n'),
      fromStrings: false,
    };
  }
  return { commands: stringCommands(text, language), shellText: null, fromStrings: true };
}

/** A shell source's logical lines, comments left out, continuations joined. */
function shellLines(text: string, language: 'shell' | 'cmd' | 'powershell'): SourceCommand[] {
  const lines = text.split(/\r?\n/);
  const out: SourceCommand[] = [];
  const continues = language === 'cmd' ? /\^$/ : language === 'powershell' ? /`$/ : /\\$/;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i] ?? '';
    while (continues.test(line) && i + 1 < lines.length) {
      line = `${line.slice(0, -1)} ${lines[++i] ?? ''}`;
    }
    let s = line.trim();
    if (language === 'powershell') {
      // `<# … #>` block comments.
      if (inBlock) {
        const end = s.indexOf('#>');
        if (end < 0) continue;
        s = s.slice(end + 2).trim();
        inBlock = false;
      }
      const open = s.indexOf('<#');
      if (open >= 0 && !s.includes('#>', open)) {
        inBlock = true;
        s = s.slice(0, open).trim();
      }
    }
    if (language === 'cmd') {
      // `@echo off`, `@pip install x`: the `@` only hides the echo.
      s = s.replace(/^@\s*/, '');
      if (/^(rem\b|::)/i.test(s)) continue;
    } else if (s.startsWith('#')) {
      continue;
    }
    if (s !== '') out.push({ line: start + 1, command: s });
  }
  return out;
}

interface LexerConfig {
  lineComments: readonly string[];
  blockComments: ReadonlyArray<readonly [string, string]>;
  quotes: readonly string[];
  /** Python's `'''` and `"""`. */
  triple: boolean;
  /** Quotes whose string ends at the end of its line when left open. */
  singleLine: readonly string[];
  /** The interpolation inside a string, replaced by `$` (a value of the run). */
  interpolation: ReadonlyArray<{ open: string; close: string; quotes: readonly string[] }>;
  /** A string prefix that turns interpolation on (Python's `f`). */
  interpolatingPrefix?: RegExp;
}

const LEXERS: Record<'python' | 'javascript' | 'ruby' | 'perl' | 'php', LexerConfig> = {
  python: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ["'", '"'],
    triple: true,
    singleLine: ["'", '"'],
    interpolation: [{ open: '{', close: '}', quotes: ["'", '"'] }],
    interpolatingPrefix: /[fF]/,
  },
  javascript: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: ["'", '"', '`'],
    triple: false,
    singleLine: ["'", '"'],
    interpolation: [{ open: '${', close: '}', quotes: ['`'] }],
  },
  ruby: {
    lineComments: ['#'],
    blockComments: [['=begin', '=end']],
    quotes: ["'", '"', '`'],
    triple: false,
    singleLine: [],
    interpolation: [{ open: '#{', close: '}', quotes: ['"', '`'] }],
  },
  perl: {
    lineComments: ['#'],
    // POD: documentation from a `=word` line to `=cut`.
    blockComments: [
      ['=pod', '=cut'],
      ['=head', '=cut'],
      ['=begin', '=cut'],
      ['=over', '=cut'],
    ],
    quotes: ["'", '"', '`'],
    triple: false,
    singleLine: [],
    interpolation: [],
  },
  php: {
    lineComments: ['//', '#'],
    blockComments: [['/*', '*/']],
    quotes: ["'", '"', '`'],
    triple: false,
    singleLine: [],
    interpolation: [],
  },
};

/**
 * Installs a language does through its own API, not a program: read as the
 * program they stand for, followed by the statement's strings
 * (`pip.main(["install", "x"])` reads `pip install x`).
 */
const LANGUAGE_INSTALLS: Partial<
  Record<SourceLanguage, ReadonlyArray<{ call: RegExp; as: string }>>
> = {
  python: [{ call: /\bpip(?:\._internal(?:\.\w+)*)?\.main\s*\(/, as: 'pip' }],
  ruby: [{ call: /\bGem(?:\.install\b|::(?:Dependency)?Installer\b)/, as: 'gem install' }],
};

type Word = { literal: true; value: string; line: number } | { literal: false };

interface Statement {
  words: Word[];
  /** The code outside strings and comments. */
  code: string;
  line: number;
}

function isEmpty(s: Statement): boolean {
  return s.words.length === 0 && s.code.trim() === '';
}

/** The statements of a source, each as its strings and the values between them. */
function statements(text: string, language: keyof typeof LEXERS): Statement[] {
  const cfg = LEXERS[language];
  const out: Statement[] = [];
  let current: Statement = { words: [], code: '', line: 1 };
  let line = 1;
  let depth = 0;
  let other = false;
  let lastSignificant = '';
  const flushOther = (): void => {
    if (other) current.words.push({ literal: false });
    other = false;
  };
  const endStatement = (): void => {
    flushOther();
    if (current.words.length > 0 || current.code.trim() !== '') out.push(current);
    current = { words: [], code: '', line };
  };
  let i = 0;
  const at = (s: string): boolean => text.startsWith(s, i);
  while (i < text.length) {
    const ch = text[i] ?? '';
    // Comments: skipped, their newline kept.
    const lineComment = cfg.lineComments.find(at);
    if (lineComment !== undefined) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const block = cfg.blockComments.find(([open]) => at(open));
    if (block !== undefined) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? text.length : end + block[1].length;
      for (let j = i; j < stop; j++) if (text[j] === '\n') line++;
      i = stop;
      continue;
    }
    // Strings, with an optional Python prefix (`f"…"`, `rb'…'`).
    const prefix = /^[rRbBuUfF]{1,2}(?=['"])/.exec(text.slice(i, i + 3));
    const quoteAt = prefix ? i + prefix[0].length : i;
    const quote = cfg.quotes.find((q) => text.startsWith(q, quoteAt));
    if (quote !== undefined && (prefix === null || language === 'python')) {
      const prev = text[i - 1] ?? '';
      if (prefix === null || !/[\w]/.test(prev)) {
        const triple = cfg.triple && text.startsWith(quote.repeat(3), quoteAt);
        const close = triple ? quote.repeat(3) : quote;
        const interpolate = cfg.interpolation.filter(
          (p) =>
            p.quotes.includes(quote) &&
            (cfg.interpolatingPrefix === undefined ||
              (prefix !== null && cfg.interpolatingPrefix.test(prefix[0]))),
        );
        const startLine = line;
        let j = quoteAt + close.length;
        let value = '';
        while (j < text.length) {
          if (text.startsWith(close, j)) {
            j += close.length;
            break;
          }
          const c = text[j] ?? '';
          if (c === '\n') {
            if (!triple && cfg.singleLine.includes(quote)) break;
            line++;
          }
          if (c === '\\' && j + 1 < text.length) {
            const next = text[j + 1] ?? '';
            if (next === '\n') line++;
            value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
            j += 2;
            continue;
          }
          const interp = interpolate.find((p) => text.startsWith(p.open, j));
          if (interp !== undefined) {
            let level = 1;
            j += interp.open.length;
            while (j < text.length && level > 0) {
              if (text[j] === '{') level++;
              else if (text[j] === '}') level--;
              else if (text[j] === '\n') line++;
              j++;
            }
            value += '$';
            continue;
          }
          value += c;
          j++;
        }
        flushOther();
        if (isEmpty(current)) current.line = startLine;
        current.words.push({ literal: true, value, line: startLine });
        lastSignificant = quote;
        i = j;
        continue;
      }
    }
    if (ch === '\n') {
      line++;
      i++;
      if (depth === 0 && !/[\\,+(\[{=.|&]/.test(lastSignificant)) endStatement();
      continue;
    }
    if (ch === ';' && depth === 0) {
      i++;
      endStatement();
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!/\s/.test(ch) && isEmpty(current)) current.line = line;
    if ('()[]{},;'.includes(ch)) flushOther();
    else if (!/\s/.test(ch)) other = true;
    if (!/\s/.test(ch)) lastSignificant = ch;
    current.code += ch;
    i++;
  }
  endStatement();
  return out;
}

/** The commands a non-shell source's strings spell, with the installs of its API. */
function stringCommands(text: string, language: keyof typeof LEXERS): SourceCommand[] {
  const out: SourceCommand[] = [];
  for (const statement of statements(text, language)) {
    const words = statement.words.map((w) => (w.literal ? w.value : '$'));
    statement.words.forEach((w, i) => {
      if (!w.literal || w.value.trim() === '') return;
      out.push({ line: w.line, command: words.slice(i, i + MAX_ARGUMENT_WORDS).join(' ') });
    });
    for (const { call, as } of LANGUAGE_INSTALLS[language] ?? []) {
      if (!call.test(statement.code)) continue;
      const literals = statement.words.flatMap((w) => (w.literal ? [w.value] : []));
      out.push({
        line: statement.line,
        command: [as, ...literals].slice(0, MAX_ARGUMENT_WORDS).join(' '),
      });
    }
  }
  return out;
}
