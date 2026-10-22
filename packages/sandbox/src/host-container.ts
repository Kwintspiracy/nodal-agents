// host-container.ts — le conteneur d'un job tel que le runner le voit : un
// HÔTE (job-host.ts) qui lance chaque commande du job comme son enfant, joint
// par ses flux standard, et ce qui le tient (#628, #755).
//
// Deux détenteurs, un seul client :
//   - confiné (windows-mxc.ts) : l'hôte tourne dans un conteneur MXC, que le
//     courtier tient ; fermer le conteneur tue tout ce qu'il contient ;
//   - non confiné, sous Windows (`openJobObjectContainer`) : l'hôte tourne
//     hors bac à sable, rangé dans un Job Object « tué à la fermeture »
//     (windows-job-object.ts) AVANT qu'il ne lance quoi que ce soit ; le
//     fermer tue tous les descendants de l'hôte, détachés compris.
// Le protocole, la façon de tuer UNE commande (taskkill /T depuis le runner)
// et la fin d'une commande (son processus racine, ses flux vidés) sont les
// mêmes : il n'y a qu'une copie de chacun.

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { windowsSpawnParts } from './command-line';
import { ensureJobHostScript } from './job-host';
import {
  JOB_PROCESS_KILL_FAILED,
  defaultKillLog,
  isProcessAlive,
  killProcessTree,
  type KillLog,
} from './process-tree';
import { openKillOnCloseJob, type KillOnCloseJob } from './windows-job-object';
import {
  SandboxStartError,
  type CommandLaunch,
  type JobContainer,
  type ProcessEnd,
  type StartedProcess,
} from './types';

/** Le temps laissé à l'hôte d'un conteneur pour se dire prêt. */
export const HOST_READY_TIMEOUT_MS = 60_000;

/** Ce qui relie le runner à l'hôte d'un conteneur, quel qu'en soit le détenteur. */
export interface HostChannel {
  /** Le pid du processus hôte. */
  readonly pid: number;
  /** Résolue quand l'hôte s'est arrêté, avec la fin de sa sortie d'erreur. */
  readonly exited: Promise<{ code: number | null; output: string }>;
  /** Écrit sur l'entrée standard de l'hôte. */
  write(data: string): void;
  /** Ce que l'hôte écrit sur sa sortie standard, dans l'ordre, rien de perdu. */
  onOutput(listener: (chunk: string) => void): void;
  /** Tue l'hôte ET tout ce qu'il a lancé : le geste du détenteur. */
  kill(): void;
}

export function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function comspecOf(env: Readonly<Record<string, string | undefined>>): string {
  // ComSpec de l'environnement de l'ENFANT, comme Node le lit pour `shell: true`.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'COMSPEC');
  return (key && env[key]) || 'cmd.exe';
}

interface PendingCommand {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | null;
  killRequested: boolean;
  resolve: (end: ProcessEnd) => void;
  /** Le sort du lancement : `null` démarré, sinon la raison. */
  spawned: (failure: string | null) => void;
}

interface HostMessage {
  fatal?: string;
  ready?: boolean;
  id?: number;
  started?: number;
  s?: 'o' | 'e';
  d?: string;
  exit?: number | null;
  signal?: string | null;
  error?: string;
}

/** Un conteneur de job : un hôte, joint par son canal, et les commandes qu'il porte. */
export class HostJobContainer implements JobContainer {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private dead = false;
  private hostOutput = '';
  private buffer = '';
  private readonly exited: Promise<void>;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly channel: HostChannel) {
    channel.onOutput((chunk) => this.receive(chunk));
    // Ce que l'hôte a écrit sur sa sortie d'erreur (une panne de Node au
    // démarrage) arrive avec son arrêt — cité, borné. Une panne plus tard
    // arrive par le canal (`fatal`).
    this.exited = channel.exited.then((r) => {
      // Jamais une raison vide : sans un mot de l'hôte, au moins son code.
      const said = r.output.trim() || `exit code ${r.code ?? 'unknown'}`;
      this.hostOutput = `${this.hostOutput}${said}`.slice(-2_000);
      this.markDead();
    });
  }

  get alive(): boolean {
    return !this.dead;
  }

  private reason(code: string): string {
    const said = this.hostOutput.trim();
    return said ? `${code}: ${said}` : code;
  }

  private markDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.readyWaiter?.reject(new SandboxStartError(this.reason('SANDBOX_HOST_EXITED')));
    for (const [id, cmd] of this.pending) {
      this.pending.delete(id);
      cmd.stdout.end();
      cmd.stderr.end();
      const end: ProcessEnd = cmd.killRequested
        ? { kind: 'signal' }
        : { kind: 'error', message: this.reason('SANDBOX_CONTAINER_EXITED') };
      cmd.spawned(end.kind === 'error' ? end.message : null);
      cmd.resolve(end);
    }
  }

  /** Les lignes JSON de l'hôte ; une ligne illisible est ignorée. */
  private receive(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      let m: HostMessage;
      try {
        m = JSON.parse(line) as HostMessage;
      } catch {
        continue;
      }
      this.handle(m);
    }
  }

  /** Attend l'hôte, lui donne l'environnement passé, attend son `ready`. */
  async init(env: Record<string, string>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SandboxStartError(this.reason('SANDBOX_HOST_NOT_READY'))),
        HOST_READY_TIMEOUT_MS,
      );
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      if (this.dead)
        this.readyWaiter.reject(new SandboxStartError(this.reason('SANDBOX_HOST_EXITED')));
      else this.send({ op: 'init', env });
    });
    this.readyWaiter = null;
  }

  private send(message: unknown): void {
    this.channel.write(`${JSON.stringify(message)}\n`);
  }

  private handle(m: HostMessage): void {
    if (m.fatal !== undefined) {
      this.hostOutput = `${this.hostOutput}${m.fatal}`.slice(-2_000);
      return;
    }
    if (m.ready) {
      this.readyWaiter?.resolve();
      return;
    }
    const cmd = m.id === undefined ? undefined : this.pending.get(m.id);
    if (!cmd || m.id === undefined) return;
    if (m.started !== undefined) {
      cmd.pid = m.started;
      cmd.spawned(null);
      if (cmd.killRequested) void killProcessTree(m.started);
    } else if (m.d !== undefined) {
      (m.s === 'e' ? cmd.stderr : cmd.stdout).write(Buffer.from(m.d, 'base64'));
    } else if (m.error !== undefined || 'exit' in m) {
      this.pending.delete(m.id);
      cmd.stdout.end();
      cmd.stderr.end();
      cmd.spawned(m.error ?? null);
      cmd.resolve(
        m.error !== undefined
          ? { kind: 'error', message: m.error }
          : typeof m.exit === 'number'
            ? { kind: 'exit', exitCode: m.exit }
            : { kind: 'signal' },
      );
    }
  }

  async start(launch: CommandLaunch): Promise<StartedProcess> {
    if (this.dead) {
      throw new SandboxStartError(this.reason('SANDBOX_CONTAINER_EXITED'));
    }
    const id = ++this.nextId;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolve!: (end: ProcessEnd) => void;
    const done = new Promise<ProcessEnd>((r) => (resolve = r));
    let spawnedOnce!: (failure: string | null) => void;
    const spawned = new Promise<string | null>((r) => (spawnedOnce = r));
    const cmd: PendingCommand = {
      stdout,
      stderr,
      pid: null,
      killRequested: false,
      resolve,
      spawned: spawnedOnce,
    };
    this.pending.set(id, cmd);
    const parts = windowsSpawnParts(launch.target, comspecOf(launch.env));
    const piped = launch.stdin === 'pipe';
    this.send({
      op: 'run',
      id,
      ...parts,
      cwd: launch.cwd,
      env: definedEnv(launch.env),
      ...(piped ? { stdin: true } : {}),
    });
    // L'entrée de la commande, relayée par l'hôte : chaque morceau part dans
    // l'ordre, et la fin de l'écriture ferme l'entrée de la commande.
    const stdin = piped
      ? new Writable({
          write: (chunk: Buffer, _enc, cb) => {
            if (!this.dead) this.send({ op: 'in', id, d: Buffer.from(chunk).toString('base64') });
            cb();
          },
          final: (cb) => {
            if (!this.dead) this.send({ op: 'in-end', id });
            cb();
          },
        })
      : null;
    return {
      stdin,
      stdout,
      stderr,
      done,
      spawned,
      kill: () => {
        // Une commande finie (sa sortie reçue, ou l'hôte mort) n'a plus rien à
        // tuer : sa racine est morte, et `taskkill /T` ne trouverait aucun
        // arbre sous elle. Son pid, lui, peut déjà servir à un autre processus
        // de la machine, que ce kill tuerait avec son arbre (#841).
        if (cmd.killRequested || !this.pending.has(id)) return;
        cmd.killRequested = true;
        if (cmd.pid !== null) void killProcessTree(cmd.pid);
      },
    };
  }

  async close(): Promise<void> {
    if (!this.dead) this.channel.kill();
    await this.exited;
  }
}

/**
 * L'environnement de l'hôte non confiné : le strict nécessaire pour que Node
 * démarre, rien de ce qui change ce qu'il exécute AVANT d'être rangé dans le
 * job (`NODE_OPTIONS` pourrait lui faire charger un module qui lancerait un
 * processus hors du job). Chaque commande reçoit son propre environnement
 * entier, par le canal.
 */
const HOST_ENV_NAMES = ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP'];

function hostEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && HOST_ENV_NAMES.includes(k.toUpperCase())) out[k] = v;
  }
  return out;
}

export interface JobObjectContainerOptions {
  /** Le job dont ce conteneur porte les processus, pour les journaux. */
  jobId: string;
  /** L'environnement d'où l'hôte prend le strict nécessaire (PATH, SYSTEMROOT…). */
  env: Readonly<Record<string, string | undefined>>;
  log?: KillLog;
  /** Injectable pour les tests (un Job Object qui refuse). */
  openJob?: () => Promise<KillOnCloseJob>;
}

/**
 * Le conteneur NON CONFINÉ d'un job sous Windows (#755) : l'hôte, rangé dans
 * un Job Object neuf avant qu'il lance quoi que ce soit, et ses commandes.
 * Lève `SandboxStartError` (code `JOB_OBJECT_FAILED: …`) quand le job ne peut
 * pas être tenu : la commande est alors refusée, jamais lancée hors du job.
 */
export async function openJobObjectContainer(
  opts: JobObjectContainerOptions,
): Promise<JobContainer> {
  const log = opts.log ?? defaultKillLog;
  let job: KillOnCloseJob;
  try {
    job = await (opts.openJob ?? openKillOnCloseJob)();
  } catch (e) {
    throw new SandboxStartError(e instanceof Error ? e.message : String(e));
  }
  const script = ensureJobHostScript();
  const environment = hostEnvironment(opts.env);
  const child = spawn(process.execPath, [script], {
    cwd: dirname(script),
    // L'environnement EXACT de l'hôte, rien de celui du processus courant.
    env: environment as unknown as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const spawned = await new Promise<Error | null>((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (e) => resolve(e));
  });
  if (spawned !== null || child.pid === undefined) {
    await job.close();
    throw new SandboxStartError(`SANDBOX_HOST_START_FAILED: ${spawned?.message ?? 'no pid'}`);
  }
  // LA fenêtre d'évasion se ferme ici : l'hôte n'a encore rien lancé (il
  // attend `init`), et il ne recevra `init` qu'une fois membre du job.
  try {
    job.assign(child.pid);
  } catch (e) {
    child.kill();
    await job.close();
    throw new SandboxStartError(e instanceof Error ? e.message : String(e));
  }

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => (stderrTail = `${stderrTail}${d}`.slice(-2_000)));
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8');
  const early: string[] = [];
  let listener: ((chunk: string) => void) | null = null;
  child.stdout?.on('data', (d: string) => (listener ? listener(d) : early.push(d)));
  const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.once('close', (code) => resolve({ code, output: stderrTail }));
  });
  let closing: Promise<void> | null = null;
  const channel: HostChannel = {
    pid: child.pid,
    exited,
    write: (data) => {
      child.stdin?.write(data);
    },
    onOutput: (l) => {
      listener = l;
      for (const chunk of early.splice(0)) l(chunk);
    },
    kill: () => {
      closing ??= job.close().then((left) => {
        for (const pid of left) {
          log(JOB_PROCESS_KILL_FAILED, { pid, how: 'job-object', jobId: opts.jobId });
        }
        // L'hôte encore vivant après la fermeture du job : il n'en était pas
        // membre, et ce qu'il a lancé non plus. Dit, puis tué seul — une
        // fermeture qui attendrait sa sortie ne finirait jamais.
        // Lu au niveau de l'OS : Node n'a pas forcément encore vu sa sortie.
        if (isProcessAlive(child.pid as number)) {
          log(JOB_PROCESS_KILL_FAILED, {
            pid: child.pid,
            how: 'job-object-host',
            jobId: opts.jobId,
          });
          child.kill('SIGKILL');
        }
      });
    },
  };
  const container = new HostJobContainer(channel);
  // L'hôte mort de lui-même (tué de l'extérieur) : ce que le job tenait
  // encore meurt avec le Job Object, pas plus tard — un job ouvert sans hôte
  // ne servirait plus personne.
  void exited.then(() => channel.kill());
  try {
    await container.init(environment);
  } catch (e) {
    await container.close();
    throw e instanceof SandboxStartError ? e : new SandboxStartError(String(e));
  }
  const close = container.close.bind(container);
  return {
    get alive() {
      return container.alive;
    },
    start: (launch) => container.start(launch),
    close: async () => {
      await close();
      channel.kill();
      await closing;
    },
  };
}
