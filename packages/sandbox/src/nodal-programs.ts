// nodal-programs.ts — les programmes que NODAL lance lui-même (git surtout)
// sur un dossier qu'une commande confinée peut écrire (#628, audit P1-2).
//
// Pourquoi. Un tel programme lit la configuration de ce dossier : le
// `.git/config` d'un dépôt (ou d'un sous-dépôt imbriqué), qu'une commande
// confinée a pu écrire. `core.fsmonitor`, un filtre (`filter.*.clean`), un
// `textconv` y nomment une commande que git EXÉCUTE — mesuré : un
// `core.fsmonitor` planté s'exécute sur `git status` (git 2.55). Lancé hors
// conteneur, c'est une évasion : la commande plantée tourne sur l'hôte.
//
// Le mécanisme est UN (règle #11) : le même que pour les commandes, un
// conteneur MXC. Sans réseau (`deny-all` : un programme de Nodal n'en a pas
// besoin, et une commande plantée n'a rien à exfiltrer par là), avec pour seuls
// dossiers inscriptibles ceux que l'appelant nomme, et en lecture ceux qu'il
// doit lire même sous le dossier de données refusé.
//
// Git a besoin de son ARBRE DE TRAVAIL en écriture, même pour lire : MXC
// refuse un `chdir` dans un dossier accordé en lecture seule (mesuré le 16/10 :
// `git status` → « cannot come back to cwd: Permission denied » ; le SDK n'a
// pas de droit « traverser »). Ce dossier est celui du job, que ses commandes
// écrivent déjà : le conteneur de git n'en reçoit pas plus qu'elles.
// Bac à sable indisponible : le programme tourne sur l'hôte, exactement comme
// avant (`execFile` / `spawn` de Node) — pas de confinement ici quand il n'y en
// a pour aucune commande. De même quand l'utilisateur a COUPÉ le bac à sable de
// l'espace pour lequel Nodal lance ce programme (#876) : l'interrupteur couvre
// tous les lancements confinés de l'espace, ses commandes comme son git — une
// commande non confinée peut déjà tout faire sur l'hôte, confiner le git qui
// relit son dossier n'y retirerait rien. L'appelant DIT pour quel espace il
// lance (`workspace`), relu à chaque session ; hors espace (le CLI qui
// restaure un instantané), `noWorkspaceSandbox`.
//
// UNE SESSION PAR OPÉRATION (un instantané, une phase de constat) : ses appels
// partagent un conteneur par jeu de dossiers (mesuré : ~170 ms pour un
// conteneur neuf, ~30 ms par appel de plus), et `close()` le tue — rien de ce
// qu'une commande plantée aurait lancé ne survit à l'opération.

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { JobProcessScope } from './job-scope';
import type { WorkspaceSandboxReader } from './policy';
import { createSandbox, type Sandbox } from './status';
import { mxcBackend } from './windows-mxc';

/** Ce qu'un programme de Nodal reçoit pour UN lancement. */
export interface ProgramRunOptions {
  readonly cwd?: string;
  /** L'environnement EXACT du programme ; celui du processus par défaut. */
  readonly env?: NodeJS.ProcessEnv;
  /** Borne de temps (ms), comme `execFile` : le programme est tué au-delà. */
  readonly timeout?: number;
  /** Borne de sortie (octets), comme `execFile`. */
  readonly maxBuffer?: number;
  /** Ce que le programme doit pouvoir ÉCRIRE (aucun pour une lecture). */
  readonly writableRoots: readonly string[];
  /** Ce qu'il doit pouvoir LIRE, même sous le dossier de données refusé. */
  readonly readableRoots: readonly string[];
}

/** Un programme lancé en flux. */
export interface ProgramChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Demande l'arrêt. Idempotent. */
  kill(): void;
  /** Sa fin : le code de sortie, `null` s'il a été tué. Ne rejette jamais. */
  readonly closed: Promise<{ code: number | null }>;
}

/** Lancer un programme de Nodal : la forme d'`execFile` et de `spawn`. */
export interface ProgramRunner {
  /**
   * Comme `execFile` (sortie en texte UTF-8) : rejette sur un code non nul
   * (`err.code` = le code), un dépassement de borne (`err.killed` = true), ou
   * un lancement impossible (l'erreur du système, ou `SandboxStartError`).
   */
  execFile(
    file: string,
    args: readonly string[],
    opts: ProgramRunOptions,
  ): Promise<{ stdout: string; stderr: string }>;
  /** Lance en flux ; rejette si le programme ne peut pas démarrer. */
  spawn(
    file: string,
    args: readonly string[],
    opts: Omit<ProgramRunOptions, 'timeout' | 'maxBuffer'>,
  ): Promise<ProgramChild>;
}

/** Une session : un `ProgramRunner` dont `close()` tue ce qu'elle a ouvert. */
export interface NodalPrograms extends ProgramRunner {
  /** Les programmes tournent-ils dans le bac à sable ? */
  readonly confined: boolean;
  close(): Promise<void>;
}

// ─── Hors conteneur : Node, tel quel ─────────────────────────────────────────

/** Les programmes sur l'hôte : `execFile` et `spawn` de Node, inchangés. */
export const hostPrograms: ProgramRunner = {
  execFile(file, args, opts) {
    return new Promise((resolve, reject) => {
      nodeExecFile(
        file,
        [...args],
        {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  },
  spawn(file, args, opts) {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn(file, [...args], {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        windowsHide: true,
      });
      const closed = new Promise<{ code: number | null }>((r) =>
        child.on('close', (code) => r({ code })),
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.off('error', reject);
        child.on('error', () => undefined); // une erreur tardive finit par `close`
        resolve({
          stdout: child.stdout,
          stderr: child.stderr,
          kill: () => child.kill(),
          closed,
        });
      });
    });
  },
};

// ─── Dans le bac à sable ─────────────────────────────────────────────────────

let programsSandbox: Sandbox | undefined;

/**
 * Le bac à sable des programmes de Nodal : le backend de ce système, en
 * `deny-all`. Sa disponibilité est la sienne (sondée une fois, mise en cache) :
 * il ne dépend ni du proxy ni des ports de Nodal, donc il marche aussi depuis
 * le CLI, qui restaure un instantané sans runner.
 */
export function nodalProgramsSandbox(): Sandbox {
  return (programsSandbox ??= createSandbox(
    process.platform === 'win32' ? mxcBackend(undefined, 'deny-all') : null,
    {
      log: (code, fields) => console.warn(`[sandbox:nodal-programs] ${code}`, fields),
    },
  ));
}

let sessions = 0;

/** Pour quel espace Nodal lance ses programmes, et sous quel bac à sable. */
export interface NodalProgramsOptions {
  /**
   * Le réglage du bac à sable de l'espace (#876), relu à l'ouverture de la
   * session : coupé, les programmes tournent sur l'hôte. `noWorkspaceSandbox`
   * pour un lancement qui n'appartient à aucun espace. LÈVE quand le réglage
   * est illisible : la session ne s'ouvre pas.
   */
  readonly workspace: WorkspaceSandboxReader;
  /** Le bac à sable (tests) ; celui des programmes de Nodal par défaut. */
  readonly sandbox?: Sandbox;
}

/** Ouvre une session de programmes de Nodal (une par opération). */
export async function openNodalPrograms(opts: NodalProgramsOptions): Promise<NodalPrograms> {
  const sandbox = opts.sandbox ?? nodalProgramsSandbox();
  const status = await sandbox.status();
  const settings = await opts.workspace();
  if (status.state !== 'available' || !sandbox.backend || !settings.enabled) {
    return { ...hostPrograms, confined: false, close: async () => undefined };
  }
  const scope = new JobProcessScope(`nodal-programs-${++sessions}`, sandbox);
  const spawn: ProgramRunner['spawn'] = async (file, args, opts) => {
    const env = opts.env ?? process.env;
    const container = await scope.container(opts.writableRoots, env, opts.readableRoots);
    const p = await container.start({
      target: { file, args: [...args] },
      // Le dossier de départ doit être lisible DANS le conteneur.
      cwd: opts.cwd ?? opts.readableRoots[0] ?? opts.writableRoots[0] ?? tmpdir(),
      env,
    });
    if (!p.stdout || !p.stderr) throw new Error(`NODAL_PROGRAM_NO_PIPES: ${file}`);
    return {
      stdout: p.stdout,
      stderr: p.stderr,
      kill: () => p.kill(),
      closed: p.done.then((end) => ({ code: end.kind === 'exit' ? end.exitCode : null })),
    };
  };
  return {
    confined: true,
    spawn,
    execFile: (file, args, opts) => execOver(spawn, file, args, opts),
    close: () => scope.close(),
  };
}

/** Ouvre une session, y fait `fn`, la ferme — quoi qu'il arrive. */
export async function withNodalPrograms<T>(
  fn: (programs: NodalPrograms) => Promise<T>,
  opts: NodalProgramsOptions,
): Promise<T> {
  const programs = await openNodalPrograms(opts);
  try {
    return await fn(programs);
  } finally {
    await programs.close();
  }
}

/** Erreur de la forme de celles d'`execFile`. */
interface ExecError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * `execFile` par-dessus un `spawn` confiné : même contrat (sortie en texte,
 * borne de temps → `killed`, borne de sortie → `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,
 * code non nul → `code`).
 */
async function execOver(
  spawn: ProgramRunner['spawn'],
  file: string,
  args: readonly string[],
  opts: ProgramRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  const child = await spawn(file, args, opts);
  const max = opts.maxBuffer ?? 1024 * 1024;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outSize = 0;
  let errSize = 0;
  let overflow = false;
  let timedOut = false;
  const take = (into: Buffer[], chunk: Buffer, size: number): number => {
    const next = size + chunk.length;
    if (next > max) {
      overflow = true;
      child.kill();
      return size;
    }
    into.push(chunk);
    return next;
  };
  child.stdout.on('data', (c: Buffer) => (outSize = take(out, c, outSize)));
  child.stderr.on('data', (c: Buffer) => (errSize = take(err, c, errSize)));
  const timer =
    opts.timeout !== undefined && opts.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeout)
      : undefined;
  const { code } = await child.closed;
  if (timer) clearTimeout(timer);
  const stdout = Buffer.concat(out).toString('utf8');
  const stderr = Buffer.concat(err).toString('utf8');
  const cmd = `${file} ${args.join(' ')}`;
  if (timedOut || overflow || code !== 0) {
    const e: ExecError = new Error(
      overflow
        ? `stdout maxBuffer length exceeded: ${cmd}`
        : `Command failed: ${cmd}${stderr ? `\n${stderr}` : ''}`,
    );
    e.code = overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : timedOut ? null : code;
    e.killed = timedOut || overflow || code === null;
    e.signal = timedOut || code === null ? 'SIGTERM' : null;
    e.stdout = stdout;
    e.stderr = stderr;
    throw e;
  }
  return { stdout, stderr };
}

/**
 * Tests seulement : le bac à sable des programmes de Nodal (`undefined` = celui
 * du système). Un test qui simule git en remplaçant `node:child_process` passe
 * un bac à sable indisponible pour que git reste sur l'hôte, où sa simulation
 * s'applique.
 */
export function _setNodalProgramsSandboxForTests(sandbox: Sandbox | undefined): void {
  programsSandbox = sandbox;
}
