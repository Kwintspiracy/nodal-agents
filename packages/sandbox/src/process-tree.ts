// process-tree.ts — tuer l'arbre d'UNE commande, une seule fois dans le dépôt
// (#750).
//
// Il en existait cinq copies : le moteur shell, `code_task`, le tour d'une CLI
// (runtime), le périmètre du job (fin du job) et le conteneur MXC. Toutes
// faisaient presque la même chose, chacune avec son repli et son silence :
// une commande que Nodal n'avait pas pu tuer ne se disait nulle part.
//
// Windows : `taskkill /T` résout l'arbre depuis un instantané VIVANT — tuer la
// racine d'abord orphelinerait ses enfants, et taskkill ne les trouverait plus.
// Donc taskkill seul (il tue aussi la racine) ; `backstop` (le `kill()` du
// processus enfant, quand l'appelant en tient un) seulement si taskkill n'a pas
// pu démarrer ou a échoué. Il est lancé depuis le runner : lancé DANS un
// conteneur MXC, il est refusé (mesuré le 14/10).
//
// Unix : la commande est lancée cheffe de son groupe de processus
// (`detached: true`) ; le pid négatif vise tout le groupe.
//
// Ce que cette fonction ne tue PAS : un descendant DÉTACHÉ de l'arbre (sous
// Windows, un petit-enfant dont le parent est mort ; sous Unix, un `setsid`).
// Il vit jusqu'à la fin du JOB, qui le tue (job-scope.ts) — c'est la décision
// du 14/10, pas une fuite.
//
// Invariant #4 : un arbre que Nodal n'a pas pu tuer est journalisé avec un
// code stable et le pid, jamais avalé.

import { spawn } from 'node:child_process';

/** Journalisé quand Nodal n'a pas pu tuer un processus qu'un job a lancé. */
export const JOB_PROCESS_KILL_FAILED = 'JOB_PROCESS_KILL_FAILED';

export type KillLog = (code: string, data: Record<string, unknown>) => void;

export const defaultKillLog: KillLog = (code, data) =>
  console.error(`[job-processes] ${code}`, JSON.stringify(data));

/** Le processus `pid` existe encore (signal 0 : rien n'est envoyé). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : il existe, mais n'est pas à nous.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  /** Le `kill()` du processus enfant, quand l'appelant en tient un. */
  backstop?: () => void;
  /** Ce qu'on dit d'un arbre qu'on n'a pas pu tuer (le job, l'usage). */
  context?: Record<string, unknown>;
  log?: KillLog;
}

/**
 * Tue l'arbre de processus de `pid`. Résolue quand le geste est fait (taskkill
 * terminé sous Windows) ; ne rejette jamais. Un échec est journalisé
 * (`JOB_PROCESS_KILL_FAILED`, avec le pid) quand la racine vit encore après.
 */
export function killProcessTree(
  pid: number | undefined,
  opts: KillTreeOptions = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? defaultKillLog;
  const backstop = (): void => {
    try {
      opts.backstop?.();
    } catch {
      /* déjà mort */
    }
  };
  const failed = (how: string, detail?: string): void => {
    if (pid !== undefined && isProcessAlive(pid)) {
      log(JOB_PROCESS_KILL_FAILED, {
        pid,
        how,
        ...(detail !== undefined ? { detail } : {}),
        ...opts.context,
      });
    }
  };
  if (pid === undefined) {
    backstop();
    return Promise.resolve();
  }
  if (platform === 'win32') {
    return new Promise<void>((resolve) => {
      let said = '';
      try {
        const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        tk.stderr?.on('data', (d: Buffer) => (said += String(d)));
        tk.on('close', (code) => {
          if (code !== 0) {
            backstop();
            failed('taskkill', `exit ${String(code)}: ${said.trim().slice(0, 300)}`);
          }
          resolve();
        });
        tk.on('error', (e) => {
          backstop();
          failed('taskkill', e.message);
          resolve();
        });
      } catch (e) {
        backstop();
        failed('taskkill', e instanceof Error ? e.message : String(e));
        resolve();
      }
    });
  }
  let error: NodeJS.ErrnoException | null = null;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    // ESRCH : le groupe est déjà vide. Toute autre erreur (EPERM) est dite.
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = e as NodeJS.ErrnoException;
  }
  backstop();
  if (error) {
    log(JOB_PROCESS_KILL_FAILED, {
      pid,
      how: 'kill-group',
      detail: error.message,
      ...opts.context,
    });
  }
  return Promise.resolve();
}
