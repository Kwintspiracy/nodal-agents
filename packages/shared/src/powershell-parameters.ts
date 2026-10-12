// powershell-parameters.ts — a PowerShell command's words, bound the way
// PowerShell binds them (#694).
//
// The floor and the shell checklist read PowerShell parameters in eight places
// (Remove-Item's -Recurse/-Force, Start-Process, -OutFile, Out-File's path,
// Set-Location, the powershell CLI's -Command/-File, Invoke-Expression). Each
// had its own spelling of the rule: full names only (`-f(orce)?`, `-recurse`),
// a prefix of three letters or more, a regex of nested optionals. PowerShell
// binds any prefix of a parameter's name, an alias (`-cf`, `-LP`), a value
// glued with `:` (`-Force:$false`, `-OutFile:a.jpg`), in any case, after any
// of its four dashes (`-`, `–`, `—`, `―`). `Remove-Item -Recurse -Fo C:\`
// passed the floor while `-Force` did not.
//
// ONE reading, here. A word is matched against the parameters of the command
// it is given to (`PsSignature`):
// - an exact name or alias is that parameter;
// - otherwise every parameter whose name or an alias starts with the word is
//   a parameter it COULD bind. PowerShell refuses an ambiguous prefix and runs
//   nothing, so counting each of them is never wrong about a command that
//   runs, and a net may over-ask, never under-report.
// A splat (`@params`) can bind any parameter, with a value decided when the
// command runs.
//
// The powershell / pwsh program reads its own command line with the same
// prefix rule, plus `/` and a doubled dash (`/c`, `--command`), and no `:`
// value; its `-Command` and `-File` take every word after them (`cli`).

/** One parameter of a PowerShell command. */
export interface PsParameter {
  aliases?: readonly string[];
  /** A switch takes no value of its own: `-Force`, `-Force:$false`. */
  switch?: boolean;
  /** The CLI's `-Command` / `-File`: every word after it is its value. */
  rest?: boolean;
}

/** The parameters of a PowerShell command, by full name in lower case. */
export interface PsSignature {
  parameters: Readonly<Record<string, PsParameter>>;
  /** The powershell / pwsh command line, not a cmdlet: `/` leads, `:` is no value. */
  cli?: boolean;
}

/** One word of a PowerShell command, bound. */
export interface PsBinding {
  /**
   * The parameters it could bind, by full name: one when it is unambiguous,
   * several for an ambiguous prefix, none for a parameter the command does not
   * have; null for a positional word.
   */
  names: readonly string[] | null;
  /** Its value: glued (`-X:v`), the next word, a positional word; null for a bare switch. */
  value: string | null;
  /** Where its value stands among the words (where the rest starts, for `rest`). */
  index: number;
}

/** The dashes PowerShell takes before a parameter's name. */
const DASHES = '-\u2013\u2014\u2015';

/** The value a splat gives every parameter: decided when the command runs. */
const SPLATTED = '$splat';

/** What a word names as a parameter, if it is one: its key and its glued value. */
function parameterWord(
  word: string,
  sig: PsSignature,
): { key: string; value: string | null; trailingColon: boolean } | null {
  const lead = word[0] ?? '';
  if (!DASHES.includes(lead) && !(sig.cli === true && lead === '/')) return null;
  let rest = word.slice(1);
  // The CLI reads `--command` as `-command`.
  if (sig.cli === true && DASHES.includes(lead) && rest.startsWith(lead)) rest = rest.slice(1);
  if (sig.cli === true)
    return /^[\p{L}_?]/u.test(rest) ? { key: rest, value: null, trailingColon: false } : null;
  const colon = rest.indexOf(':');
  const key = colon < 0 ? rest : rest.slice(0, colon);
  // A name starts with a letter: `-` alone, `--` (end of parameters) and a
  // negative number (`-5`) name no parameter.
  if (!/^[\p{L}_?]/u.test(key)) return null;
  const glued = colon < 0 ? null : rest.slice(colon + 1);
  return { key, value: glued === '' ? null : glued, trailingColon: glued === '' };
}

/** The parameters `key` could bind (see the head of this file). */
function namesOf(key: string, sig: PsSignature): string[] {
  const k = key.toLowerCase();
  const entries = Object.entries(sig.parameters);
  const exact = entries.find(([name, p]) => name === k || (p.aliases ?? []).includes(k));
  if (exact) return [exact[0]];
  return entries
    .filter(([name, p]) => name.startsWith(k) || (p.aliases ?? []).some((a) => a.startsWith(k)))
    .map(([name]) => name);
}

/**
 * The parameters one word could bind, or null when it is not a parameter
 * word at all (a value, a positional word, `--`).
 */
export function psParameterNames(word: string, sig: PsSignature): string[] | null {
  const p = parameterWord(word, sig);
  return p === null ? null : namesOf(p.key, sig);
}

/** True when `word` could bind parameter `name` of `sig`. */
export function isPsParameter(word: string, sig: PsSignature, name: string): boolean {
  return psParameterNames(word, sig)?.includes(name) ?? false;
}

/**
 * The words of a PowerShell command, bound left to right. A parameter takes
 * the next word as its value when one of the parameters it could bind takes
 * a value and none is glued; `-Name: value` (a space after the colon) takes
 * the next word, switch or not. After `--`, every word is positional. On the
 * CLI, the first positional word and a `rest` parameter end the reading.
 */
export function bindPsArguments(args: readonly string[], sig: PsSignature): PsBinding[] {
  const bound: PsBinding[] = [];
  const all = Object.keys(sig.parameters);
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (!positionalOnly && sig.cli !== true && /^@[\w:]+$/.test(word)) {
      bound.push({ names: all, value: SPLATTED, index: i });
      continue;
    }
    if (!positionalOnly && word === '--') {
      positionalOnly = true;
      continue;
    }
    const p = positionalOnly ? null : parameterWord(word, sig);
    if (p === null) {
      bound.push({ names: null, value: word, index: i });
      if (sig.cli === true) break;
      continue;
    }
    const names = namesOf(p.key, sig);
    const params = names.map((n) => sig.parameters[n] ?? {});
    if (params.some((q) => q.rest === true)) {
      bound.push({ names, value: args[i + 1] ?? null, index: i + 1 });
      break;
    }
    const takesValue = p.trailingColon || params.some((q) => q.switch !== true);
    if (p.value !== null || !takesValue || names.length === 0) {
      bound.push({ names, value: p.value, index: i });
      continue;
    }
    bound.push({ names, value: args[i + 1] ?? null, index: i + 1 });
    i += 1;
  }
  return bound;
}

/** The values given to parameter `name` (a positional word is not one). */
export function psValues(bound: readonly PsBinding[], name: string): string[] {
  return bound
    .filter((b) => b.names?.includes(name) === true && b.value !== null)
    .map((b) => b.value as string);
}

/** The positional words, in order. */
export function psPositional(bound: readonly PsBinding[]): string[] {
  return bound.filter((b) => b.names === null).map((b) => b.value as string);
}

/** True when a word names a parameter the command does not have (PowerShell refuses it). */
export function psHasUnknownParameter(bound: readonly PsBinding[]): boolean {
  return bound.some((b) => b.names !== null && b.names.length === 0);
}

/**
 * The state of switch `name`: false when absent or given `$false` / `0`,
 * true when given bare or `$true` / `1`, null when its value is decided when
 * the command runs (`-Force:$f`, a splat). A caller that would ask LESS for a
 * set switch reads only `true`; one that would ask MORE reads `!== false`.
 */
export function psSwitch(bound: readonly PsBinding[], name: string): boolean | null {
  let state: boolean | null = false;
  for (const b of bound) {
    if (b.names?.includes(name) !== true) continue;
    const v = (b.value ?? '$true').toLowerCase();
    if (v === '$true' || v === '1') return true;
    if (v !== '$false' && v !== '0') state = null;
  }
  return state;
}

// ── Signatures ───────────────────────────────────────────────────────────────
// From each command's documentation (PowerShell 7.4 and Windows PowerShell
// 5.1), provider-dynamic parameters included. A parameter missing here is one
// PowerShell would refuse (`psHasUnknownParameter`).

const COMMON: Record<string, PsParameter> = {
  verbose: { aliases: ['vb'], switch: true },
  debug: { aliases: ['db'], switch: true },
  erroraction: { aliases: ['ea'] },
  warningaction: { aliases: ['wa'] },
  informationaction: { aliases: ['infa'] },
  progressaction: { aliases: ['proga'] },
  errorvariable: { aliases: ['ev'] },
  warningvariable: { aliases: ['wv'] },
  informationvariable: { aliases: ['iv'] },
  outvariable: { aliases: ['ov'] },
  outbuffer: { aliases: ['ob'] },
  pipelinevariable: { aliases: ['pv'] },
};

const SHOULD_PROCESS: Record<string, PsParameter> = {
  whatif: { aliases: ['wi'], switch: true },
  confirm: { aliases: ['cf'], switch: true },
};

const LITERAL_PATH: PsParameter = { aliases: ['pspath', 'lp'] };

/**
 * What every cmdlet that supports ShouldProcess has: the common parameters,
 * -WhatIf and -Confirm. Not a whole signature (the cmdlet's own parameters are
 * not here): read only `whatif` with it. A word it reads as -WhatIf is -WhatIf,
 * or a prefix PowerShell refuses as ambiguous, and either way the cmdlet does
 * nothing; `psHasUnknownParameter` means nothing on it (#693).
 */
export const SHOULD_PROCESS_CMDLET: PsSignature = {
  parameters: { ...COMMON, ...SHOULD_PROCESS },
};

/** Remove-Item, and its aliases ri, rm, del, erase, rd, rmdir. */
export const REMOVE_ITEM: PsSignature = {
  parameters: {
    path: {},
    literalpath: LITERAL_PATH,
    filter: {},
    include: {},
    exclude: {},
    recurse: { switch: true },
    force: { switch: true },
    credential: {},
    stream: {},
    ...COMMON,
    ...SHOULD_PROCESS,
  },
};

/** Start-Process, and its aliases start, saps. */
export const START_PROCESS: PsSignature = {
  parameters: {
    filepath: { aliases: ['pspath', 'path'] },
    argumentlist: { aliases: ['args'] },
    credential: { aliases: ['runas'] },
    workingdirectory: {},
    loaduserprofile: { aliases: ['lup'], switch: true },
    nonewwindow: { aliases: ['nnw'], switch: true },
    passthru: { switch: true },
    redirectstandarderror: { aliases: ['rse'] },
    redirectstandardinput: { aliases: ['rsi'] },
    redirectstandardoutput: { aliases: ['rso'] },
    verb: {},
    windowstyle: {},
    wait: { switch: true },
    usenewenvironment: { switch: true },
    environment: {},
    ...COMMON,
    ...SHOULD_PROCESS,
  },
};

/** Invoke-WebRequest / Invoke-RestMethod (iwr, irm): where they write. */
export const INVOKE_WEB_REQUEST: PsSignature = {
  parameters: {
    uri: {},
    outfile: {},
    operationtimeoutseconds: {},
    ...COMMON,
  },
};

/** Start-BitsTransfer: where it writes. */
export const START_BITS_TRANSFER: PsSignature = {
  parameters: {
    source: {},
    destination: {},
    description: {},
    displayname: {},
    ...COMMON,
    ...SHOULD_PROCESS,
  },
};

const ENCODING: PsParameter = {};

/** Out-File: `Out-File [-FilePath] <path> [[-Encoding] <e>]`. */
export const OUT_FILE: PsSignature = {
  parameters: {
    filepath: { aliases: ['path'] },
    literalpath: LITERAL_PATH,
    encoding: ENCODING,
    append: { switch: true },
    force: { switch: true },
    noclobber: { aliases: ['nc'], switch: true },
    width: {},
    nonewline: { switch: true },
    inputobject: {},
    ...COMMON,
    ...SHOULD_PROCESS,
  },
};

/** Set-Content / Add-Content: `[-Path] <path> [-Value] <v>`. */
export const SET_CONTENT: PsSignature = {
  parameters: {
    path: {},
    literalpath: LITERAL_PATH,
    value: {},
    passthru: { switch: true },
    filter: {},
    include: {},
    exclude: {},
    force: { switch: true },
    credential: {},
    nonewline: { switch: true },
    encoding: ENCODING,
    stream: {},
    asbytestream: { switch: true },
    ...COMMON,
    ...SHOULD_PROCESS,
  },
};

/** Tee-Object: `[-FilePath] <path>`. */
export const TEE_OBJECT: PsSignature = {
  parameters: {
    filepath: { aliases: ['path'] },
    literalpath: LITERAL_PATH,
    variable: {},
    append: { switch: true },
    encoding: ENCODING,
    inputobject: {},
    ...COMMON,
  },
};

/** Set-Location / Push-Location (sl, cd, chdir, pushd in PowerShell): `[-Path] <path>`. */
export const SET_LOCATION: PsSignature = {
  parameters: {
    path: {},
    literalpath: LITERAL_PATH,
    passthru: { switch: true },
    stackname: {},
    ...COMMON,
  },
};

/** Invoke-Expression (iex): `[-Command] <string>`. */
export const INVOKE_EXPRESSION: PsSignature = {
  parameters: { command: {}, ...COMMON },
};

/**
 * The powershell / pwsh command line (`about_Pwsh`, `about_PowerShell_exe`).
 * The first positional word is a script for pwsh, a command for Windows
 * PowerShell; either way it takes the words after it.
 */
export const POWERSHELL_CLI: PsSignature = {
  cli: true,
  parameters: {
    command: { aliases: ['c'], rest: true },
    file: { aliases: ['f'], rest: true },
    encodedcommand: { aliases: ['e', 'ec'] },
    encodedarguments: { aliases: ['encodeda', 'ea'] },
    configurationname: { aliases: ['config'] },
    configurationfile: {},
    custompipename: {},
    executionpolicy: { aliases: ['ex', 'ep'] },
    help: { aliases: ['?', 'h'], switch: true },
    inputformat: { aliases: ['inp', 'if'] },
    interactive: { aliases: ['i'], switch: true },
    login: { aliases: ['l'], switch: true },
    mta: { switch: true },
    noexit: { aliases: ['noe'], switch: true },
    nologo: { aliases: ['nol'], switch: true },
    noninteractive: { aliases: ['noni'], switch: true },
    noprofile: { aliases: ['nop'], switch: true },
    noprofileloadtime: { switch: true },
    outputformat: { aliases: ['o', 'of'] },
    psconsolefile: {},
    settingsfile: { aliases: ['settings'] },
    sshservermode: { aliases: ['sshs'], switch: true },
    sta: { switch: true },
    version: { aliases: ['v'] },
    windowstyle: { aliases: ['w'] },
    workingdirectory: { aliases: ['wd'] },
  },
};
