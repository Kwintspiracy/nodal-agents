// process-watch.ts — savoir si un processus de test est MORT sans se laisser
// tromper par la réutilisation de son pid (#834).
//
// `process.kill(pid, 0)` répond pour le pid, pas pour le processus. Windows
// redonne vite un pid libéré : mesuré le 22/10 (Windows 11 26200), le même pid
// revient au bout d'environ 240 créations de processus, soit quelques secondes
// d'une suite qui en lance des centaines. Un processus mort dont le pid sert
// déjà à un inconnu passe donc pour vivant (« expected true to be false » sur
// un test de mort), et un processus tué à tort peut passer pour vivant aussi
// (un test de survie vert pour rien).
//
// Sous Windows, un pid n'est jamais redonné tant qu'un handle ouvert tient le
// processus : l'objet du noyau survit à la mort du processus, et son pid avec
// lui. `watchProcess` ouvre ce handle dès que le test apprend le pid, et
// `alive()` lit le code de sortie du processus TENU, jamais celui du pid. Tant
// que la veille est ouverte, `process.kill(pid, 0)` devient lui aussi exact,
// dans le test comme dans une commande-sonde : le pid ne peut désigner que ce
// processus, vivant ou mort.
//
// Ce que la veille ne peut pas garantir : que le pid désigne encore le bon
// processus AU MOMENT où elle s'ouvre. On l'ouvre dès que le pid est lu, quand
// le processus vient de l'écrire ; un test qui veut en être sûr fait suivre la
// veille d'une preuve d'activité (le compteur qui monte, counter-process.ts).
//
// Sous Unix, un pid n'est redonné qu'après avoir parcouru toute la plage
// (`pid_max`, des millions sous Linux) : `process.kill(pid, 0)` suffit à
// l'échelle d'un test, et la veille ne tient rien.
//
// TUER PAR LA VEILLE, jamais par le numéro (#841). Un `process.kill(pid)` sur
// un pid dont le processus est mort tue celui qui l'a reçu depuis : sous
// Windows, TerminateProcess, code de sortie 1, aucune sortie. Sur la CI
// Windows, `pnpm test` lance trois paquets à la fois ; le nettoyage d'un test
// du banc tuait les pid de lanceurs morts depuis vingt secondes, et l'audit des
// processus du runner a montré ces pid déjà redonnés à des processus d'autres
// paquets (run 39786905701). Quand le receveur était un worker vitest, le
// paquet perdait un fichier sans un mot (« Worker exited unexpectedly »).
// `kill()` ne signale que le processus TENU, et seulement s'il vit : le pid ne
// peut pas désigner un autre processus tant que la veille est ouverte. La
// règle vaut pour tous les tests du dépôt, et la garde
// `src/tests/no-kill-by-pid.test.ts` refuse un `process.kill(pid, signal)` écrit
// ailleurs qu'ici.

import type * as KoffiModule from 'koffi';

/** Un processus surveillé par le test. `release()` quand le test en a fini. */
export interface ProcessWatch {
  readonly pid: number;
  /** Quand la veille s'est ouverte (`Date.now()`) : depuis quand le test tient ce processus. */
  readonly openedAt: number;
  /** Le processus surveillé vit encore (un processus suspendu ou affamé vit). */
  alive(): boolean;
  /**
   * Tue le processus surveillé s'il vit encore ; ne fait rien s'il est mort.
   * Rend `true` quand un signal est parti.
   */
  kill(signal?: NodeJS.Signals): boolean;
  /** Ferme la veille : le pid redevient libre d'être redonné. Idempotent. */
  release(): void;
}

const SYNCHRONIZE = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
/** `OpenProcess` sur un pid qui ne désigne plus aucun processus. */
const ERROR_INVALID_PARAMETER = 87;

interface Kernel32 {
  OpenProcess(access: number, inherit: number, pid: number): unknown;
  GetExitCodeProcess(proc: unknown, code: number[]): number;
  CloseHandle(h: unknown): number;
  GetLastError(): number;
}

let kernel32: Promise<Kernel32> | undefined;

function loadKernel32(): Promise<Kernel32> {
  kernel32 ??= (async (): Promise<Kernel32> => {
    // koffi est CommonJS : son export est `default` sous `import()`.
    const imported = (await import('koffi')) as unknown as { default?: unknown };
    const koffi = (imported.default ?? imported) as typeof KoffiModule;
    const lib = koffi.load('kernel32.dll');
    koffi.pointer('TESTKIT_HANDLE', koffi.opaque());
    // BOOL est un entier de 4 octets : `int`, pas le `bool` de C.
    return {
      OpenProcess: lib.func(
        'TESTKIT_HANDLE __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)',
      ) as Kernel32['OpenProcess'],
      GetExitCodeProcess: lib.func(
        'int __stdcall GetExitCodeProcess(TESTKIT_HANDLE proc, _Out_ uint32 *code)',
      ) as Kernel32['GetExitCodeProcess'],
      CloseHandle: lib.func(
        'int __stdcall CloseHandle(TESTKIT_HANDLE h)',
      ) as Kernel32['CloseHandle'],
      // koffi préserve la dernière erreur de l'appel précédent.
      GetLastError: lib.func('uint32 __stdcall GetLastError()') as Kernel32['GetLastError'],
    };
  })();
  return kernel32;
}

function unixAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : il existe, mais n'est pas à nous.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Surveille le processus `pid`, à ouvrir dès que le test apprend le pid. Lève
 * quand Windows refuse le handle pour une autre raison que « ce pid ne désigne
 * plus rien » : une veille qui ne tiendrait rien ne doit pas se taire.
 */
export async function watchProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessWatch> {
  if (platform !== 'win32') {
    const alive = (): boolean => unixAlive(pid);
    return {
      pid,
      openedAt: Date.now(),
      alive,
      kill: (signal) => killIfAlive(pid, alive, signal),
      release: () => undefined,
    };
  }
  const k = await loadKernel32();
  const handle = k.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) {
    const err = k.GetLastError();
    // Déjà mort, et son objet déjà détruit : il est mort, et le restera.
    if (err === ERROR_INVALID_PARAMETER) {
      return {
        pid,
        openedAt: Date.now(),
        alive: () => false,
        kill: () => false,
        release: () => undefined,
      };
    }
    throw new Error(`watchProcess(${String(pid)}): OpenProcess error ${String(err)}`);
  }
  let open = true;
  const watch: ProcessWatch = {
    pid,
    openedAt: Date.now(),
    kill(signal?: NodeJS.Signals): boolean {
      // `alive()` lève après `release()` : tuer un pid qu'on ne tient plus est
      // exactement ce que cette méthode existe pour empêcher.
      return killIfAlive(pid, () => watch.alive(), signal);
    },
    alive(): boolean {
      if (!open) throw new Error(`watchProcess(${String(pid)}): read after release`);
      const code = [0];
      if (!k.GetExitCodeProcess(handle, code)) {
        throw new Error(
          `watchProcess(${String(pid)}): GetExitCodeProcess error ${String(k.GetLastError())}`,
        );
      }
      return code[0] === STILL_ACTIVE;
    },
    release(): void {
      if (!open) return;
      open = false;
      k.CloseHandle(handle);
    },
  };
  return watch;
}

function killIfAlive(pid: number, alive: () => boolean, signal?: NodeJS.Signals): boolean {
  if (!alive()) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    // ESRCH : il vient de mourir, entre la lecture et le signal.
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}

/** Ce qu'a donné l'attente de la mort d'un processus tenu. */
export interface DeathWait {
  dead: boolean;
  /** Combien de temps on l'a attendue (`0` quand il était déjà mort). */
  waitedMs: number;
}

/**
 * Attend, borné, que le processus TENU meure : la mort est lue sur lui, jamais
 * sur son pid, et jamais sur une fenêtre fixe qui ne dit pas combien de temps
 * il a survécu.
 */
export async function waitForDeath(watch: ProcessWatch, ms: number): Promise<DeathWait> {
  const started = Date.now();
  for (;;) {
    if (!watch.alive()) return { dead: true, waitedMs: Date.now() - started };
    if (Date.now() - started >= ms) return { dead: false, waitedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Le message d'un processus tenu qui a survécu à ce qui devait le tuer :
 * « server (pid 4242) held since 12:00:00.000 still alive 5000 ms after closeJobProcessScope ».
 * Un tel échec n'est pas une réutilisation de pid, la veille l'exclut : c'est
 * un processus qui n'est pas mort.
 */
export function survivalMessage(
  watch: ProcessWatch,
  wait: DeathWait,
  what: string,
  after: string,
): string {
  const since = new Date(watch.openedAt).toISOString().slice(11, 23);
  return `${what} (pid ${String(watch.pid)}) held since ${since} still alive ${String(wait.waitedMs)} ms after ${after}`;
}

/**
 * Attend, borné, que le processus TENU meure, et fait échouer le test en
 * disant depuis quand il est tenu et combien de temps il a survécu à `after`.
 */
export async function mustDie(
  watch: ProcessWatch,
  what: string,
  after: string,
  ms = 10_000,
): Promise<void> {
  const wait = await waitForDeath(watch, ms);
  if (!wait.dead) throw new Error(survivalMessage(watch, wait, what, after));
}

/** Les veilles d'un fichier de test : `hold(pid)` à chaque pid lu, `releaseAll()` dans `afterEach`. */
export function watchRegistry(): {
  hold(pid: number): Promise<ProcessWatch>;
  releaseAll(): void;
} {
  const open: ProcessWatch[] = [];
  return {
    async hold(pid) {
      const watch = await watchProcess(pid);
      open.push(watch);
      return watch;
    },
    releaseAll() {
      for (const w of open.splice(0)) w.release();
    },
  };
}
