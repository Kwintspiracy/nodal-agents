// program-options.ts — the options a program that runs another one takes
// before the command it runs (#715, Nodal review pass 2 of PR #730).
//
// `sudo -u root rm x`, `timeout -k 5 10 curl x`, `parallel -j 4 rm {}`: where
// the command starts depends on which options take the next word as their
// value. The reading skipped every option and took the next word only for the
// options a short list named as valued; any other option was taken for a
// switch, and its value for the command. `parallel --replace X rm -rf X ::: a`
// was read as running the program `X`: no kind at all, even under "ask".
//
// The rule now: a program's grammar names its switches, its valued options
// and its options whose value is optional, as its manual writes them. An
// option the grammar cannot classify makes the reading opaque: the command
// may start right after it, or after the word it may take, and the program
// it runs is decided at run time, which asks under any autonomy (invariant
// #4). Each of those starts is kept as a candidate (Nodal review pass 3): the
// kinds and the hard floor still read what may run, so no longer guessing
// never makes the floor blinder than the guess was.
//
// Read as getopt reads them: `--` ends the options; a word that does not start
// with `-` is the command; `--name=value` is one word, whatever `name` is; a
// group of short letters (`-rf`, `-j4`) is read letter by letter, a valued
// letter taking the rest of the word or the next one, an optional one only
// the rest of the word (`watch -d1`). A long option is read only by its exact
// name: an abbreviation (`--rep`) could be any option of a program whose
// manual the grammar does not hold in full.

/** The options of one program, as written in its manual. */
export interface OptionGrammar {
  /** Options that take no value: `-v`, `--verbose`. */
  switches: ReadonlySet<string>;
  /** Options that take the next word (or the rest of a short group) as their value. */
  valued: ReadonlySet<string>;
  /** Options whose value is optional, given glued only: `-d1`, `--differences=1`, or none. */
  optional: ReadonlySet<string>;
  /**
   * Every option is one word, its value glued with `=` (firejail): no option
   * can take the next word, so none hides where the command starts.
   */
  gluedOnly?: boolean;
}

/**
 * A grammar from a program's manual: its short switches, valued and optional
 * letters, then its long switches, valued and optional options (single-dash
 * long names, as expect's `spawn -noecho`, go with the long ones).
 */
export function optionGrammar(
  shortSwitches: string,
  shortValued: string,
  longSwitches: readonly string[] = [],
  longValued: readonly string[] = [],
  shortOptional = '',
  longOptional: readonly string[] = [],
): OptionGrammar {
  const short = (letters: string) => [...letters].map((c) => `-${c}`);
  return {
    switches: new Set([...short(shortSwitches), ...longSwitches]),
    valued: new Set([...short(shortValued), ...longValued]),
    optional: new Set([...short(shortOptional), ...longOptional]),
  };
}

/** A program's options, read: where its command may start, and each valued option with its value. */
export interface OptionsRead {
  /**
   * Where the command may start (`words.length` when there is none): one
   * index when every option is classified; past an option the grammar cannot
   * classify, each start it may give, in order.
   */
  starts: number[];
  /** True when an option could not be classified: which start is the command's is the program's call. */
  opaque: boolean;
  /** Each valued option given, by the name it was written with (`-c`, `--command`), and its value. */
  values: Array<{ option: string; value: string }>;
}

/**
 * How many words one option takes (1 or 2), its value recorded in `values`;
 * null when the grammar cannot classify it.
 */
function optionWords(
  word: string,
  next: string | undefined,
  grammar: OptionGrammar,
  values: OptionsRead['values'],
): number | null {
  if (grammar.gluedOnly === true || grammar.switches.has(word) || grammar.optional.has(word))
    return 1;
  if (grammar.valued.has(word)) {
    values.push({ option: word, value: next ?? '' });
    return 2;
  }
  // `--name=value`: one word, its value glued.
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    if (eq < 0) return null;
    values.push({ option: word.slice(0, eq), value: word.slice(eq + 1) });
    return 1;
  }
  // A group of short letters: switches, then at most one letter with a value,
  // a valued one taking the rest of the word or the next one, an optional one
  // the rest of the word only.
  for (let j = 1; j < word.length; j++) {
    const option = `-${word[j]}`;
    const glued = word.slice(j + 1);
    if (grammar.switches.has(option)) continue;
    if (grammar.optional.has(option)) {
      if (glued !== '') values.push({ option, value: glued });
      return 1;
    }
    if (!grammar.valued.has(option)) return null;
    values.push({ option, value: glued !== '' ? glued : (next ?? '') });
    return glued !== '' ? 1 : 2;
  }
  return 1;
}

/**
 * A program's options among `words` (its words after its name), read with
 * its grammar. Past an option it cannot classify, the reading goes on both
 * ways: the option alone, and the option with the next word as its value.
 */
export function readOptions(words: readonly string[], grammar: OptionGrammar): OptionsRead {
  const values: OptionsRead['values'] = [];
  const read = new Map<number, number[]>();
  let opaque = false;
  const from = (start: number): number[] => {
    const known = read.get(start);
    if (known !== undefined) return known;
    read.set(start, []);
    let i = start;
    let starts: number[] | null = null;
    while (starts === null) {
      const word = words[i];
      if (word === undefined) starts = [words.length];
      else if (word === '--') starts = [i + 1];
      else if (!/^-./.test(word)) starts = [i];
      else {
        const taken = optionWords(word, words[i + 1], grammar, values);
        if (taken !== null) i += taken;
        else {
          opaque = true;
          starts = [...from(i + 1), ...(i + 1 < words.length ? from(i + 2) : [])];
        }
      }
    }
    read.set(start, starts);
    return starts;
  };
  const starts = [...new Set(from(0))].sort((x, y) => x - y);
  return { starts, opaque, values };
}

const VERSION_HELP = ['--help', '--version'];

/**
 * The grammars of the programs that run another one after their options,
 * from each program's manual (GNU coreutils, util-linux, procps, sudo, GNU
 * parallel, findutils' xargs, strace, ltrace, valgrind, expect…). An option
 * missing here is read as one the grammar cannot classify: the reading is
 * opaque and asks, never wrong about what runs.
 */
export const PROGRAM_OPTIONS = {
  sudo: optionGrammar(
    'AbBEeHiKklnNPSsVv',
    'CDghprRtTUu',
    [
      '--askpass',
      '--background',
      '--bell',
      '--preserve-env',
      '--edit',
      '--set-home',
      '--login',
      '--remove-timestamp',
      '--reset-timestamp',
      '--list',
      '--non-interactive',
      '--no-update',
      '--preserve-groups',
      '--stdin',
      '--shell',
      '--validate',
      ...VERSION_HELP,
    ],
    [
      '--close-from',
      '--chdir',
      '--group',
      '--host',
      '--prompt',
      '--chroot',
      '--role',
      '--type',
      '--command-timeout',
      '--other-user',
      '--user',
    ],
  ),
  // busybox's own modes (`--list`…) are read apart: past them, `--` and an applet.
  busybox: optionGrammar('', ''),
  doas: optionGrammar('Lns', 'Cu'),
  nohup: optionGrammar('', '', VERSION_HELP),
  nice: optionGrammar('', 'n', VERSION_HELP, ['--adjustment']),
  time: optionGrammar(
    'apqvV',
    'fo',
    ['--append', '--portability', '--quiet', '--verbose', ...VERSION_HELP],
    ['--format', '--output'],
  ),
  timeout: optionGrammar(
    'v',
    'ks',
    ['--preserve-status', '--foreground', '--verbose', ...VERSION_HELP],
    ['--kill-after', '--signal'],
  ),
  setsid: optionGrammar('cfwhV', '', ['--ctty', '--fork', '--wait', ...VERSION_HELP]),
  stdbuf: optionGrammar('', 'eio', VERSION_HELP, ['--error', '--input', '--output']),
  ionice: optionGrammar(
    'thV',
    'cnpPu',
    ['--ignore', ...VERSION_HELP],
    ['--class', '--classdata', '--pid', '--pgid', '--uid'],
  ),
  chrt: optionGrammar(
    'abdfimoprRvhV',
    'DPT',
    [
      '--all-tasks',
      '--batch',
      '--deadline',
      '--fifo',
      '--idle',
      '--max',
      '--other',
      '--pid',
      '--rr',
      '--reset-on-fork',
      '--verbose',
      ...VERSION_HELP,
    ],
    ['--sched-deadline', '--sched-period', '--sched-runtime'],
  ),
  taskset: optionGrammar('acphV', '', ['--all-tasks', '--cpu-list', '--pid', ...VERSION_HELP]),
  unbuffer: optionGrammar('p', ''),
  strace: optionGrammar(
    'AcCdDfFhikqrtTvVwxyzZn',
    'abeEIoOpPsSuUX',
    [
      '--summary-only',
      '--summary',
      '--daemonize',
      '--follow-forks',
      '--output-separately',
      '--instruction-pointer',
      '--stack-trace',
      '--relative-timestamps',
      '--syscall-times',
      '--no-abbrev',
      '--strings-in-hex',
      '--successful-only',
      '--failed-only',
      '--seccomp-bpf',
      '--syscall-number',
      ...VERSION_HELP,
    ],
    [
      '--output',
      '--trace',
      '--signal',
      '--status',
      '--attach',
      '--user',
      '--env',
      '--string-limit',
      '--trace-path',
      '--summary-sort-by',
      '--columns',
    ],
  ),
  ltrace: optionGrammar(
    'bcCfhiLrStTV',
    'aADeFlnopsuwx',
    ['--demangle', ...VERSION_HELP],
    ['--align', '--indent', '--library', '--output'],
  ),
  // Every valgrind option is glued (`--tool=memcheck`) or a switch.
  valgrind: optionGrammar('dhqv', '', [
    '--help-debug',
    '--help-dyn-options',
    '--quiet',
    '--verbose',
    ...VERSION_HELP,
  ]),
  // procps-ng watch(1): `-d`/`--differences[=permanent]` takes its value
  // glued only; `-s`/`--shotsdir` is left out, its manual line shows no value
  // but speaks of a folder.
  watch: optionGrammar(
    'bcCefgprtwxhv',
    'nq',
    [
      '--beep',
      '--color',
      '--no-color',
      '--errexit',
      '--follow',
      '--chgexit',
      '--precise',
      '--no-rerun',
      '--no-title',
      '--no-wrap',
      '--exec',
      ...VERSION_HELP,
    ],
    ['--interval', '--equexit'],
    'd',
    ['--differences'],
  ),
  // `flock [options] FILE -c LINE`: its `-c` is read apart (`RUNS_ANOTHER`).
  flock: optionGrammar(
    'eFhnosuVx',
    'cEw',
    [
      '--exclusive',
      '--no-fork',
      '--nb',
      '--nonblock',
      '--close',
      '--shared',
      '--unlock',
      '--verbose',
      ...VERSION_HELP,
    ],
    ['--command', '--conflict-exit-code', '--timeout', '--wait'],
  ),
  chroot: optionGrammar('', '', ['--skip-chdir', ...VERSION_HELP], ['--userspec', '--groups']),
  unshare: optionGrammar(
    'cfhrV',
    'GRSw',
    [
      '--map-current-user',
      '--fork',
      '--map-root-user',
      '--keep-caps',
      '--map-auto',
      ...VERSION_HELP,
    ],
    [
      '--setgid',
      '--root',
      '--setuid',
      '--wd',
      '--map-user',
      '--map-group',
      '--map-users',
      '--map-groups',
      '--propagation',
      '--setgroups',
      '--monotonic',
      '--boottime',
    ],
    // a namespace's file, glued: `--mount=/run/ns`
    'CimnpTuU',
    [
      '--cgroup',
      '--ipc',
      '--mount',
      '--net',
      '--pid',
      '--time',
      '--uts',
      '--user',
      '--mount-proc',
      '--kill-child',
    ],
  ),
  nsenter: optionGrammar(
    'aFhVZ',
    'GSt',
    ['--all', '--no-fork', '--follow-context', '--preserve-credentials', ...VERSION_HELP],
    ['--setgid', '--setuid', '--target'],
    // a namespace's file, the root or the working folder, glued: `-r/srv`
    'CimnprTuUw',
    [
      '--cgroup',
      '--ipc',
      '--mount',
      '--net',
      '--pid',
      '--root',
      '--time',
      '--uts',
      '--user',
      '--wd',
    ],
  ),
  'systemd-run': optionGrammar(
    'dGhPqrStV',
    'EHMpu',
    [
      '--same-dir',
      '--collect',
      '--pipe',
      '--quiet',
      '--remain-after-exit',
      '--shell',
      '--pty',
      '--user',
      '--system',
      '--scope',
      '--send-sighup',
      '--no-block',
      '--wait',
      '--no-ask-password',
      ...VERSION_HELP,
    ],
    [
      '--setenv',
      '--host',
      '--machine',
      '--property',
      '--unit',
      '--uid',
      '--gid',
      '--nice',
      '--working-directory',
      '--description',
      '--slice',
      '--service-type',
      '--on-active',
      '--on-boot',
      '--on-startup',
      '--on-unit-active',
      '--on-unit-inactive',
      '--on-calendar',
      '--path-property',
      '--socket-property',
      '--timer-property',
    ],
  ),
  // firejail writes every value glued (`--private=dir`).
  firejail: { switches: new Set(), valued: new Set(), optional: new Set(), gluedOnly: true },
  caffeinate: optionGrammar('dimsu', 'tw'),
  pkexec: optionGrammar(
    '',
    '',
    ['--disable-internal-agent', '--keep-cwd', ...VERSION_HELP],
    ['--user'],
  ),
  // `runuser -c LINE` is read apart (`RUNS_ANOTHER`).
  runuser: optionGrammar(
    'fhlmpPV',
    'cgGsuw',
    ['--login', '--preserve-environment', '--pty', ...VERSION_HELP],
    [
      '--command',
      '--group',
      '--supp-group',
      '--shell',
      '--user',
      '--whitelist-environment',
      '--session-command',
    ],
  ),
  proxychains: optionGrammar('q', 'f'),
  torsocks: optionGrammar(
    'dhiqV',
    'aPpu',
    ['--debug', '--isolate', '--quiet', '--shell', ...VERSION_HELP],
    ['--address', '--port', '--pass', '--user'],
  ),
  eatmydata: optionGrammar('', '', VERSION_HELP),
  fakeroot: optionGrammar(
    'huv',
    'bils',
    ['--unknown-is-real', ...VERSION_HELP],
    ['--lib', '--faked'],
  ),
  'dbus-launch': optionGrammar('', '', [
    '--sh-syntax',
    '--csh-syntax',
    '--auto-syntax',
    '--exit-with-session',
    '--exit-with-x11',
    '--close-stderr',
    ...VERSION_HELP,
  ]),
  // expect's `spawn`: Tcl options, one dash, full names.
  spawn: optionGrammar(
    '',
    '',
    ['-noecho', '-console', '-nottycopy', '-nottyinit', '-pty'],
    ['-ignore', '-open', '-leaveopen'],
  ),
  exec: optionGrammar('cl', 'a'),
  command: optionGrammar('pvV', ''),
  // findutils xargs(1): `-e`, `-i`, `-l` and their long forms take their value
  // glued only.
  xargs: optionGrammar(
    '0oprtx',
    'adEILnPs',
    [
      '--null',
      '--open-tty',
      '--interactive',
      '--no-run-if-empty',
      '--verbose',
      '--exit',
      '--show-limits',
      ...VERSION_HELP,
    ],
    ['--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'],
    'eil',
    ['--eof', '--replace', '--max-lines'],
  ),
  // GNU parallel 20260922: every option of its Getopt::Long table
  // (`options_completion_hash`). Perl takes a word that does not start with
  // `-` as the value of an optional string (`--replace X`, `-i X`): valued.
  // `-l` / `--max-lines` take theirs only when it is a number: left out, so
  // both readings are kept.
  parallel: optionGrammar(
    '0MTVXYghkmopqrtuvx',
    'BCDEHIJLNPSUWadeijns',
    [
      '--bar',
      '--bg',
      '--bibtex',
      '--cat',
      '--cf',
      '--citation',
      '--cleanup',
      '--color',
      '--color-fail',
      '--color-failed',
      '--colorfail',
      '--colorfailed',
      '--colour',
      '--colour-fail',
      '--colour-failed',
      '--colourfail',
      '--colourfailed',
      '--compress',
      '--compress-program',
      '--controlmaster',
      '--csv',
      '--ctag',
      '--ctrl-c',
      '--ctrlc',
      '--decompress-program',
      '--dr',
      '--dry-run',
      '--dryrun',
      '--embed',
      '--eta',
      '--exit',
      '--fast',
      '--fg',
      '--fifo',
      '--files',
      '--files0',
      '--filter-host',
      '--filter-hosts',
      '--filterhosts',
      '--gnu',
      '--group',
      '--hashbang',
      '--help',
      '--hgrp',
      '--hostgroup',
      '--hostgroups',
      '--hostgrp',
      '--interactive',
      '--keep-order',
      '--keeporder',
      '--latest-line',
      '--latestline',
      '--lb',
      '--line-buffer',
      '--line-buffered',
      '--linebuffer',
      '--linebuffered',
      '--link',
      '--ll',
      '--max-line-length-allowed',
      '--maxlinelengthallowed',
      '--nn',
      '--no-ctrl-c',
      '--no-ctrlc',
      '--no-k',
      '--no-keep-order',
      '--no-notice',
      '--no-run-if-empty',
      '--noctrlc',
      '--nok',
      '--nokeeporder',
      '--nonall',
      '--nonotice',
      '--norunifempty',
      '--noswap',
      '--null',
      '--number-of-cores',
      '--number-of-cpus',
      '--number-of-sockets',
      '--number-of-threads',
      '--numberofcores',
      '--numberofcpus',
      '--numberofsockets',
      '--numberofthreads',
      '--onall',
      '--open-tty',
      '--output-as-files',
      '--output-as-files0',
      '--outputasfiles',
      '--outputasfiles0',
      '--pipe',
      '--pipe-part',
      '--pipepart',
      '--plain',
      '--plus',
      '--progress',
      '--quote',
      '--record-env',
      '--recordenv',
      '--regex',
      '--regexp',
      '--remove-rec-sep',
      '--removerecsep',
      '--resume',
      '--resume-failed',
      '--resumefailed',
      '--retry-failed',
      '--retryfailed',
      '--round',
      '--round-robin',
      '--roundrobin',
      '--rrs',
      '--semaphore',
      '--session',
      '--shebang',
      '--shell-quote',
      '--shell_quote',
      '--shellquote',
      '--show-limits',
      '--showlimits',
      '--shuf',
      '--silent',
      '--skip-first-line',
      '--skipfirstline',
      '--spreadstdin',
      '--tag',
      '--tee',
      '--tmux',
      '--tmux-pane',
      '--tmuxpane',
      '--tollef',
      '--transfer',
      '--tty',
      '--ungroup',
      '--unsafe',
      '--use-compress-program',
      '--use-cores-instead-of-threads',
      '--use-cpus-instead-of-cores',
      '--use-decompress-program',
      '--use-sockets-instead-of-threads',
      '--usecoresinsteadofthreads',
      '--usecpusinsteadofcores',
      '--usesocketsinsteadofthreads',
      '--verbose',
      '--version',
      '--wait',
      '--will-cite',
      '--willcite',
      '--xapply',
      '--xargs',
    ],
    [
      '--arg-file',
      '--arg-file-sep',
      '--arg-sep',
      '--argfile',
      '--argfilesep',
      '--argsep',
      '--basefile',
      '--basenameextensionreplace',
      '--basenamereplace',
      '--bf',
      '--bin',
      '--block',
      '--block-size',
      '--block-timeout',
      '--blocksize',
      '--blocktimeout',
      '--bner',
      '--bnr',
      '--bt',
      '--col-sep',
      '--colsep',
      '--combine-exec',
      '--combine-executable',
      '--combineexec',
      '--combineexecutable',
      '--compressprogram',
      '--ctag-string',
      '--ctagstring',
      '--debug',
      '--decompressprogram',
      '--delay',
      '--delimiter',
      '--dirnamereplace',
      '--dnr',
      '--env',
      '--eof',
      '--er',
      '--extensionreplace',
      '--filter',
      '--group-by',
      '--groupby',
      '--halt',
      '--halt-on-error',
      '--haltonerror',
      '--header',
      '--id',
      '--jl',
      '--joblog',
      '--jobs',
      '--limit',
      '--linkinputsource',
      '--load',
      '--match',
      '--max-args',
      '--max-chars',
      '--max-procs',
      '--max-replace-args',
      '--maxargs',
      '--maxchars',
      '--maxprocs',
      '--maxreplaceargs',
      '--memfree',
      '--memsuspend',
      '--milestone',
      '--min-version',
      '--minversion',
      '--ms',
      '--nice',
      '--parens',
      '--process-slot-var',
      '--processslotvar',
      '--profile',
      '--recend',
      '--recstart',
      '--replace',
      '--res',
      '--result',
      '--results',
      '--retries',
      '--return',
      '--rpl',
      '--rsync-opts',
      '--rsyncopts',
      '--semaphore-name',
      '--semaphore-timeout',
      '--semaphorename',
      '--semaphoretimeout',
      '--seqreplace',
      '--shard',
      '--shell-completion',
      '--shellcompletion',
      '--slf',
      '--slotreplace',
      '--sql',
      '--sql-and-worker',
      '--sql-master',
      '--sql-worker',
      '--sqlandworker',
      '--sqlmaster',
      '--sqlworker',
      '--ssh',
      '--ssh-delay',
      '--sshdelay',
      '--sshlogin',
      '--sshloginfile',
      '--st',
      '--tag-string',
      '--tagstring',
      '--tempdir',
      '--template',
      '--term-seq',
      '--termseq',
      '--tf',
      '--timeout',
      '--tmpdir',
      '--tmpl',
      '--total',
      '--total-jobs',
      '--totaljobs',
      '--transfer-file',
      '--transfer-files',
      '--transferfile',
      '--transferfiles',
      '--trc',
      '--trim',
      '--usecompressprogram',
      '--usedecompressprogram',
      '--wd',
      '--work-dir',
      '--workdir',
      '--xapplyinputsource',
    ],
  ),
  // `env [options] [NAME=value]… command`: `-S LINE` is read apart (`RUNS_ANOTHER`).
  env: optionGrammar(
    '0iv',
    'CPSu',
    ['--ignore-environment', '--null', '--debug', '--list-signal-handling', ...VERSION_HELP],
    ['--chdir', '--split-string', '--unset'],
    '',
    ['--block-signal', '--default-signal', '--ignore-signal'],
  ),
} satisfies Record<string, OptionGrammar>;
