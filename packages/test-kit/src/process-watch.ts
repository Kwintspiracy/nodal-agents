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

import type * as KoffiModule from 'koffi';

/** Un processus surveillé par le test. `release()` quand le test en a fini. */
export interface ProcessWatch {
  readonly pid: number;
  /** Le processus surveillé vit encore (un processus suspendu ou affamé vit). */
  alive(): boolean;
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
    return { pid, alive: () => unixAlive(pid), release: () => undefined };
  }
  const k = await loadKernel32();
  const handle = k.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) {
    const err = k.GetLastError();
    // Déjà mort, et son objet déjà détruit : il est mort, et le restera.
    if (err === ERROR_INVALID_PARAMETER) {
      return { pid, alive: () => false, release: () => undefined };
    }
    throw new Error(`watchProcess(${String(pid)}): OpenProcess error ${String(err)}`);
  }
  let open = true;
  return {
    pid,
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
}
