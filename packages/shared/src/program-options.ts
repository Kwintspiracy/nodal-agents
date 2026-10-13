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
// The rule now: a program's grammar names its switches AND its valued
// options, as its manual writes them, and an option the grammar cannot
// classify makes the reading opaque. What the program runs is then decided at
// run time, which asks under any autonomy (invariant #4), never a command
// chosen by a guess.
//
// Read as getopt reads them: `--` ends the options; a word that does not start
// with `-` is the command; `--name=value` is one word, whatever `name` is; a
// group of short letters (`-rf`, `-j4`) is read letter by letter, a valued
// letter taking the rest of the word or the next one. A long option is read
// only by its exact name: an abbreviation (`--rep`) could be any option of a
// program whose manual the grammar does not hold in full.

/** The options of one program, as written in its manual. */
export interface OptionGrammar {
  /** Options that take no value: `-v`, `--verbose`. */
  switches: ReadonlySet<string>;
  /** Options that take the next word (or the rest of a short group) as their value. */
  valued: ReadonlySet<string>;
  /**
   * Every option is one word, its value glued with `=` (firejail): no option
   * can take the next word, so none hides where the command starts.
   */
  gluedOnly?: boolean;
}

/**
 * A grammar from a program's manual: its short switches and valued letters,
 * and its long switches and valued options (single-dash long names, as
 * expect's `spawn -noecho`, go with the long ones).
 */
export function optionGrammar(
  shortSwitches: string,
  shortValued: string,
  longSwitches: readonly string[] = [],
  longValued: readonly string[] = [],
): OptionGrammar {
  return {
    switches: new Set([...[...shortSwitches].map((c) => `-${c}`), ...longSwitches]),
    valued: new Set([...[...shortValued].map((c) => `-${c}`), ...longValued]),
  };
}

/** A program's options, read: where its command starts, and each valued option with its value. */
export interface OptionsRead {
  /** The index of the command's first word (`words.length` when there is none). */
  start: number;
  /** Each valued option given, by the name it was written with (`-c`, `--command`), and its value. */
  values: Array<{ option: string; value: string }>;
}

/**
 * A program's options among `words` (its words after its name), read with
 * its grammar; null when an option the grammar cannot classify hides where
 * the command starts.
 */
export function readOptions(words: readonly string[], grammar: OptionGrammar): OptionsRead | null {
  const values: OptionsRead['values'] = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (word === '--') return { start: i + 1, values };
    if (!/^-./.test(word)) return { start: i, values };
    if (grammar.gluedOnly === true || grammar.switches.has(word)) {
      i += 1;
      continue;
    }
    if (grammar.valued.has(word)) {
      values.push({ option: word, value: words[i + 1] ?? '' });
      i += 2;
      continue;
    }
    // `--name=value`: one word, its value glued.
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      if (eq < 0) return null;
      values.push({ option: word.slice(0, eq), value: word.slice(eq + 1) });
      i += 1;
      continue;
    }
    // A group of short letters: switches, then at most one valued letter,
    // which takes the rest of the word or the next one.
    let taken = 1;
    for (let j = 1; j < word.length; j++) {
      const option = `-${word[j]}`;
      if (grammar.switches.has(option)) continue;
      if (!grammar.valued.has(option)) return null;
      const glued = word.slice(j + 1);
      values.push({ option, value: glued !== '' ? glued : (words[i + 1] ?? '') });
      if (glued === '') taken = 2;
      break;
    }
    i += taken;
  }
  return { start: words.length, values };
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
  watch: optionGrammar(
    'bcCdeghprtwx',
    'nq',
    [
      '--beep',
      '--color',
      '--no-color',
      '--differences',
      '--errexit',
      '--chgexit',
      '--precise',
      '--no-rerun',
      '--no-title',
      '--no-wrap',
      '--exec',
      ...VERSION_HELP,
    ],
    ['--interval', '--equexit'],
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
    'cCfhimnprTuUV',
    'GRSw',
    [
      '--map-current-user',
      '--cgroup',
      '--fork',
      '--ipc',
      '--mount',
      '--net',
      '--pid',
      '--map-root-user',
      '--time',
      '--uts',
      '--user',
      '--mount-proc',
      '--kill-child',
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
  ),
  nsenter: optionGrammar(
    'aCFhimnprTuUVwZ',
    'GSt',
    [
      '--all',
      '--cgroup',
      '--no-fork',
      '--ipc',
      '--mount',
      '--net',
      '--pid',
      '--root',
      '--time',
      '--uts',
      '--user',
      '--wd',
      '--follow-context',
      '--preserve-credentials',
      ...VERSION_HELP,
    ],
    ['--setgid', '--setuid', '--target'],
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
  firejail: { switches: new Set(), valued: new Set(), gluedOnly: true },
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
  ),
  parallel: optionGrammar(
    '0gkmqrtuvX',
    'aCdEIjJLnNPsS',
    [
      '--null',
      '--group',
      '--keep-order',
      '--quote',
      '--no-run-if-empty',
      '--verbose',
      '--ungroup',
      '--line-buffer',
      '--lb',
      '--tag',
      '--ctag',
      '--dry-run',
      '--eta',
      '--progress',
      '--bar',
      '--will-cite',
      '--nonall',
      '--onall',
      '--pipe',
      '--spreadstdin',
      '--pipe-part',
      '--round-robin',
      '--round',
      '--xargs',
      '--tty',
      '--no-notice',
      '--noswap',
      '--fg',
      '--bg',
      '--resume',
      '--resume-failed',
      '--retry-failed',
      '--shuf',
      '--skip-first-line',
      '--files',
      '--record-env',
      '--plus',
      '--csv',
      '--filter-hosts',
      '--cleanup',
      '--transfer',
      ...VERSION_HELP,
    ],
    [
      '--arg-file',
      '--arg-file-sep',
      '--arg-sep',
      '--basefile',
      '--bf',
      '--block',
      '--block-size',
      '--colsep',
      '--delay',
      '--delimiter',
      '--env',
      '--halt',
      '--halt-on-error',
      '--header',
      '--joblog',
      '--jobs',
      '--load',
      '--max-args',
      '--max-chars',
      '--max-lines',
      '--max-procs',
      '--max-replace-args',
      '--memfree',
      '--nice',
      '--profile',
      '--results',
      '--res',
      '--retries',
      '--return',
      '--sshdelay',
      '--sshlogin',
      '--sshloginfile',
      '--slf',
      '--tagstring',
      '--timeout',
      '--tmpdir',
      '--transferfile',
      '--tf',
      '--workdir',
      '--wd',
    ],
  ),
  // `env [options] [NAME=value]… command`: `-S LINE` is read apart (`RUNS_ANOTHER`).
  env: optionGrammar(
    '0iv',
    'CPSu',
    ['--ignore-environment', '--null', '--debug', '--list-signal-handling', ...VERSION_HELP],
    ['--chdir', '--split-string', '--unset'],
  ),
} satisfies Record<string, OptionGrammar>;
