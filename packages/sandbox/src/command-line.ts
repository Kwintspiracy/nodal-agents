// command-line.ts — la ligne de commande Windows qu'un backend reçoit.
//
// MXC prend UNE chaîne, pas un argv. Elle doit être exactement celle que
// Node aurait passée à CreateProcess pour la même cible, sinon une commande
// confinée et la même non confinée ne liraient pas les mêmes arguments :
//
//   - une commande shell : `<ComSpec> /d /s /c "<commande>"`, la forme de
//     `spawn(cmd, { shell: true })` sous Windows ;
//   - un exécutable et ses arguments : chaque élément cité selon la règle de
//     libuv (`quote_cmd_arg`), que suivent le CRT Microsoft et
//     `CommandLineToArgvW` ;
//   - `verbatim` : les éléments joints par une espace, sans citation — la
//     forme `windowsVerbatimArguments` de Node, que seul `run_command` sous
//     liste blanche emploie (voir shell-engine.ts).

import type { LaunchTarget } from './types';

/** Cite UN argument comme libuv le fait pour CreateProcess. */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * Ce qu'il faut à `child_process.spawn` pour produire EXACTEMENT la ligne de
 * commande d'une cible : le programme à chercher (`file`), et la ligne passée
 * telle quelle (`windowsVerbatimArguments`) sous la forme `argv0 + ' ' + rest`.
 * L'hôte du conteneur d'un job (job-host.ts) lance ainsi chaque commande.
 */
export interface WindowsSpawnParts {
  readonly file: string;
  readonly argv0: string;
  readonly rest: string;
}

/** Les morceaux de la ligne Windows d'une cible. `comspec` : celui de l'environnement de l'enfant. */
export function windowsSpawnParts(target: LaunchTarget, comspec: string): WindowsSpawnParts {
  if ('command' in target) {
    return { file: comspec, argv0: comspec, rest: `/d /s /c "${target.command}"` };
  }
  if (target.windowsVerbatimArguments === true) {
    return { file: target.file, argv0: target.file, rest: target.args.join(' ') };
  }
  return {
    file: target.file,
    argv0: quoteWindowsArg(target.file),
    rest: target.args.map(quoteWindowsArg).join(' '),
  };
}

/** La ligne de commande Windows d'une cible. `comspec` : celui de l'environnement de l'enfant. */
export function windowsCommandLine(target: LaunchTarget, comspec: string): string {
  const parts = windowsSpawnParts(target, comspec);
  return parts.rest === '' ? parts.argv0 : `${parts.argv0} ${parts.rest}`;
}
