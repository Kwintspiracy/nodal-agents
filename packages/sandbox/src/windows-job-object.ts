// windows-job-object.ts — un Job Object Windows « tué à la fermeture » (#755).
//
// Sous Windows SANS bac à sable, un processus qu'une commande laisse tourner
// en se détachant (`start /b`, `Start-Process`, un enfant `detached`) n'est
// plus rattaché à aucun arbre une fois son parent mort : `taskkill /T` ne le
// trouve plus, et il survivait à son job. Le conteneur MXC, lui, le tenait.
//
// Le Job Object est l'objet du noyau qui tient un ensemble de processus, quel
// que soit leur arbre : tout processus créé par un membre en devient membre à
// sa naissance, et `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` tue tous les membres
// quand le dernier handle se ferme — y compris quand le processus qui le
// tient (le runner) MEURT sans rien fermer. Aucun droit admin.
//
// Ce que ce module garantit, et comment :
//   - sans `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, un membre ne peut pas créer un
//     processus hors du job (`CREATE_BREAKAWAY_FROM_JOB` est refusé) ;
//   - Node (libuv) range chacun de ses enfants dans SON propre job, qui
//     permet la sortie silencieuse : ce job-là s'emboîte SOUS le nôtre
//     (jobs imbriqués, Windows 8+), et la sortie silencieuse s'arrête au
//     premier job qui ne la permet pas — le nôtre. Mesuré le 22/10 (Windows
//     11 Home 26200) : `start /b`, `Start-Process` et `spawn({ detached })`
//     restent membres après la mort de leur parent, et `TerminateJobObject`
//     les tue tous ;
//   - la fenêtre d'évasion : un processus ne peut être rangé dans un job
//     qu'APRÈS sa création. Le premier membre est donc l'hôte du job
//     (job-host.ts), qui ne lance RIEN avant d'avoir reçu `init` ; le runner
//     ne le lui envoie qu'une fois `AssignProcessToJobObject` réussi
//     (host-container.ts). Chaque commande est un enfant de l'hôte, donc née
//     dans le job.
//
// Ce qu'aucun Job Object ne tient : un processus créé À LA DEMANDE d'une
// commande par un SERVICE du système (WMI `Win32_Process.Create`, le
// planificateur de tâches, un serveur COM hors processus). Il n'est le
// descendant de personne dans le job ; seul le conteneur MXC le refuse.
//
// koffi (FFI, binaires précompilés, N-API) est chargé par `import()` et sous
// Windows seulement : sous macOS et Linux il n'est jamais lu.

import type * as KoffiModule from 'koffi';

/** La classe `JobObjectExtendedLimitInformation` de SetInformationJobObject. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
/** La classe `JobObjectBasicProcessIdList` de QueryInformationJobObject. */
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** Les droits qu'AssignProcessToJobObject exige sur le processus. */
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** La place réservée à la liste des membres lue après la fermeture. */
const MAX_LISTED_PIDS = 1024;

/** Le Job Object n'a pas pu être créé, ou un processus n'a pas pu y être rangé. */
export class JobObjectError extends Error {
  readonly code = 'JOB_OBJECT_FAILED';
  constructor(message: string) {
    super(`JOB_OBJECT_FAILED: ${message}`);
    this.name = 'JobObjectError';
  }
}

/** Un Job Object ouvert, que son détenteur ferme à la fin du job. */
export interface KillOnCloseJob {
  /** Range le processus `pid` dans le job. Lève `JobObjectError`. */
  assign(pid: number): void;
  /** Les processus membres, vivants. */
  processIds(): number[];
  /**
   * Tue tous les membres et ferme le handle. Rend les pid encore membres
   * après l'attente (vide : tout est mort). Idempotent.
   */
  close(waitMs?: number): Promise<number[]>;
}

interface Kernel32 {
  CreateJobObjectW(attrs: null, name: null): unknown;
  SetInformationJobObject(job: unknown, cls: number, info: unknown, len: number): number;
  OpenProcess(access: number, inherit: number, pid: number): unknown;
  AssignProcessToJobObject(job: unknown, proc: unknown): number;
  TerminateJobObject(job: unknown, code: number): number;
  QueryInformationJobObject(
    job: unknown,
    cls: number,
    info: Buffer,
    len: number,
    ret: number[],
  ): number;
  CloseHandle(h: unknown): number;
  GetLastError(): number;
  extendedSize: number;
}

let kernel32: Promise<Kernel32> | undefined;

/** Les fonctions de kernel32 dont ce module a besoin, liées une fois par processus. */
function loadKernel32(): Promise<Kernel32> {
  kernel32 ??= (async (): Promise<Kernel32> => {
    // koffi est CommonJS : son export est `default` sous `import()`.
    const imported = (await import('koffi')) as unknown as { default?: unknown };
    const koffi = (imported.default ?? imported) as typeof KoffiModule;
    const lib = koffi.load('kernel32.dll');
    koffi.pointer('NODAL_HANDLE', koffi.opaque());
    const basic = koffi.struct('NODAL_JOBOBJECT_BASIC_LIMIT_INFORMATION', {
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    });
    const io = koffi.struct('NODAL_IO_COUNTERS', {
      ReadOperationCount: 'uint64',
      WriteOperationCount: 'uint64',
      OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64',
      WriteTransferCount: 'uint64',
      OtherTransferCount: 'uint64',
    });
    const extended = koffi.struct('NODAL_JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
      BasicLimitInformation: basic,
      IoInfo: io,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });
    // BOOL est un entier de 4 octets : `int`, pas le `bool` de C.
    return {
      CreateJobObjectW: lib.func(
        'NODAL_HANDLE __stdcall CreateJobObjectW(void *attrs, void *name)',
      ) as Kernel32['CreateJobObjectW'],
      SetInformationJobObject: lib.func(
        'int __stdcall SetInformationJobObject(NODAL_HANDLE job, int cls, _In_ NODAL_JOBOBJECT_EXTENDED_LIMIT_INFORMATION *info, uint32 len)',
      ) as Kernel32['SetInformationJobObject'],
      OpenProcess: lib.func(
        'NODAL_HANDLE __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)',
      ) as Kernel32['OpenProcess'],
      AssignProcessToJobObject: lib.func(
        'int __stdcall AssignProcessToJobObject(NODAL_HANDLE job, NODAL_HANDLE proc)',
      ) as Kernel32['AssignProcessToJobObject'],
      TerminateJobObject: lib.func(
        'int __stdcall TerminateJobObject(NODAL_HANDLE job, uint32 code)',
      ) as Kernel32['TerminateJobObject'],
      QueryInformationJobObject: lib.func(
        'int __stdcall QueryInformationJobObject(NODAL_HANDLE job, int cls, _Out_ void *info, uint32 len, _Out_ uint32 *ret)',
      ) as Kernel32['QueryInformationJobObject'],
      CloseHandle: lib.func('int __stdcall CloseHandle(NODAL_HANDLE h)') as Kernel32['CloseHandle'],
      // koffi préserve la dernière erreur de l'appel précédent (interp.cc).
      GetLastError: lib.func('uint32 __stdcall GetLastError()') as Kernel32['GetLastError'],
      extendedSize: koffi.sizeof(extended),
    };
  })();
  // Un chargement raté n'est pas mis en cache : le suivant réessaie, et chacun
  // le dit (l'appelant refuse la commande avec ce message).
  kernel32.catch(() => {
    kernel32 = undefined;
  });
  return kernel32;
}

/**
 * Ouvre un Job Object qui tue ses membres quand il se ferme. Lève
 * `JobObjectError` (koffi absent, l'appel refusé) : l'appelant ne lance alors
 * RIEN — une commande hors du job survivrait à la fin du job (invariant #4).
 */
export async function openKillOnCloseJob(): Promise<KillOnCloseJob> {
  let k: Kernel32;
  try {
    k = await loadKernel32();
  } catch (e) {
    throw new JobObjectError(`koffi: ${e instanceof Error ? e.message : String(e)}`);
  }
  const handle = k.CreateJobObjectW(null, null);
  if (!handle) throw new JobObjectError(`CreateJobObjectW: error ${String(k.GetLastError())}`);
  const zeroes = { PerProcessUserTimeLimit: 0, PerJobUserTimeLimit: 0 };
  const info = {
    BasicLimitInformation: {
      ...zeroes,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
  if (
    !k.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, k.extendedSize)
  ) {
    const err = k.GetLastError();
    k.CloseHandle(handle);
    throw new JobObjectError(`SetInformationJobObject: error ${String(err)}`);
  }
  let closed = false;

  const processIds = (): number[] => {
    if (closed) return [];
    const buf = Buffer.alloc(8 + 8 * MAX_LISTED_PIDS);
    const ret = [0];
    if (
      !k.QueryInformationJobObject(handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buf, buf.length, ret)
    ) {
      throw new JobObjectError(`QueryInformationJobObject: error ${String(k.GetLastError())}`);
    }
    const listed = buf.readUInt32LE(4);
    const out: number[] = [];
    for (let i = 0; i < listed; i++) out.push(Number(buf.readBigUInt64LE(8 + 8 * i)));
    return out;
  };

  return {
    assign(pid: number): void {
      if (closed) throw new JobObjectError('the job object is closed');
      const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!proc)
        throw new JobObjectError(`OpenProcess(${String(pid)}): error ${String(k.GetLastError())}`);
      const ok = k.AssignProcessToJobObject(handle, proc);
      const err = k.GetLastError();
      k.CloseHandle(proc);
      if (!ok) {
        throw new JobObjectError(`AssignProcessToJobObject(${String(pid)}): error ${String(err)}`);
      }
    },
    processIds,
    async close(waitMs = 2_000): Promise<number[]> {
      if (closed) return [];
      k.TerminateJobObject(handle, 1);
      // La terminaison est asynchrone : on attend que les membres sortent de
      // la liste, borné, pour dire ceux qui restent.
      let left = processIds();
      for (let waited = 0; left.length > 0 && waited < waitMs; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
        left = processIds();
      }
      closed = true;
      k.CloseHandle(handle);
      return left;
    },
  };
}
