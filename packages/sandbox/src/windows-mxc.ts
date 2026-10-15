// windows-mxc.ts — le backend Windows : Microsoft MXC (`@microsoft/mxc-sdk`),
// conteneur de processus AppContainer, sans droits admin ni compte dédié.
//
// La politique est celle que l'essai #731 a mesurée sur Windows 11 Home 25H2
// (D:\APPS\mxc-trial\RAPPORT.md), point par point :
//
//   - `ui: { disable: false }` OBLIGATOIRE : sans lui, `node`, `git`,
//     `powershell` meurent au démarrage en 0xC0000142, sans un mot sur stderr
//     (mesure 0-ui). Presse-papiers et injection d'entrées restent refusés ;
//   - chaque lecteur déclaré en LECTURE : tout chemin non déclaré est interdit
//     en lecture aussi (mesure 2b-noroots) ;
//   - réseau sortant ouvert (`egress allow`) : l'étape 1 ne confine que les
//     écritures. La boucle locale (127.0.0.1) répond avec cette seule règle —
//     mesuré le 14/10, ce qui garde une skill ComfyUI locale joignable ;
//     `ingress.hostLoopback` est refusé par ce Windows (`backend_unavailable`) ;
//   - l'environnement passé EN ENTIER (`inheritDefaultEnvironment: false`) :
//     l'environnement par défaut de MXC est le bloc du profil utilisateur,
//     variables persistées comprises — une clé d'API posée par `setx` y
//     serait. L'enfant ne reçoit que l'environnement filtré du moteur ;
//   - télémétrie coupée explicitement (`getTelemetryConsentStatus()` plantait
//     Node sur la machine de l'essai : on n'y touche pas).
//
// UN CONTENEUR PAR JOB, pas par commande (décision du 14/10) : un hôte
// (job-host.ts) y lance chaque commande du job, si bien que ce qu'une
// commande laisse tourner en arrière-plan vit jusqu'à la fin du job, puis
// meurt avec le conteneur quand le runner le ferme.
//
// Le SDK n'est chargé que sous Windows, et par `import()` : sous macOS et
// Linux il n'est jamais lu, et son absence d'une installation se dit
// (`SANDBOX_BACKEND_MISSING`) au lieu de faire tomber le runner au démarrage.

import { spawn as spawnHostSide } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import type * as MxcSdk from '@microsoft/mxc-sdk/v1';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { windowsSpawnParts } from './command-line';
import { ensureJobHostScript } from './job-host';
import { MxcBroker, mxcErrorText, type BrokeredContainer, type MxcErrorFields } from './mxc-broker';
import {
  SandboxStartError,
  type CommandLaunch,
  type JobContainer,
  type ProcessEnd,
  type SandboxBackend,
  type SandboxStatus,
  type StartedProcess,
} from './types';

type MxcModule = typeof MxcSdk;

/** Le seul palier d'isolation MXC accepté (voir la sonde). */
const ACCEPTED_TIER = 'base-container';

/** Le nom sous lequel ce backend apparaît dans le statut et les journaux. */
export const MXC_BACKEND_NAME = 'mxc-processcontainer';

/** Le temps laissé à l'hôte d'un conteneur pour se dire prêt. */
const HOST_READY_TIMEOUT_MS = 60_000;

/** Les lecteurs présents, déclarés en lecture seule. Lus une fois par processus. */
let driveRoots: string[] | undefined;
function readableDriveRoots(): string[] {
  if (driveRoots) return driveRoots;
  // A: et B: écartés : un lecteur de disquette absent peut bloquer la sonde.
  driveRoots = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => `${letter}:\\`)
    .filter((root) => existsSync(root));
  return driveRoots;
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function comspecOf(env: Readonly<Record<string, string | undefined>>): string {
  // ComSpec de l'environnement de l'ENFANT, comme Node le lit pour `shell: true`.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'COMSPEC');
  return (key && env[key]) || 'cmd.exe';
}

function hostRequest(
  script: string,
  port: number,
  token: string,
  writableRoots: readonly string[],
  environment: Record<string, string>,
): ContainerRequest {
  return {
    command: `"${process.execPath}" "${script}" ${port} ${token}`,
    filesystem: {
      readwritePaths: [...writableRoots],
      readonlyPaths: readableDriveRoots(),
    },
    network: { egress: { default: 'allow' } },
    ui: { disable: false },
    workingDirectory: dirname(script),
    environment,
    inheritDefaultEnvironment: false,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? mxcErrorText(e as MxcErrorFields) : String(e);
}

/**
 * Tue l'arbre d'une commande DEPUIS L'HÔTE Windows : `taskkill /T` lancé dans
 * le conteneur est refusé (« The user name or password is incorrect »,
 * mesuré le 14/10), lancé par le runner il tue l'arbre (mesuré aussi). Les
 * autres processus du conteneur — ceux des autres commandes du job — vivent.
 */
function killTreeFromHost(pid: number): void {
  try {
    const tk = spawnHostSide('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    tk.on('error', () => undefined);
  } catch {
    /* déjà mort */
  }
}

interface PendingCommand {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | null;
  killRequested: boolean;
  resolve: (end: ProcessEnd) => void;
}

interface HostMessage {
  hello?: string;
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

/**
 * Le conteneur d'un job : un hôte MXC, joint par une connexion TCP qu'il
 * ouvre lui-même vers ce serveur (job-host.ts dit pourquoi pas l'entrée
 * standard), et les commandes qu'il porte.
 */
class MxcJobContainer implements JobContainer {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private socket: Socket | null = null;
  private dead = false;
  private hostOutput = '';
  private readonly exited: Promise<void>;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly container: BrokeredContainer,
    private readonly server: Server,
    private readonly token: string,
  ) {
    server.on('connection', (sock) => this.accept(sock));
    // Ce que la racine du conteneur a écrit (une panne de Node au démarrage
    // de l'hôte) arrive avec son arrêt, par le courtier — cité, borné. Une
    // panne de l'hôte plus tard arrive par la connexion (`fatal`).
    this.exited = container.exited.then((r) => {
      if (r.output.trim()) this.hostOutput = `${this.hostOutput}${r.output}`.slice(-2_000);
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
    this.socket?.destroy();
    this.server.close();
    this.readyWaiter?.reject(new SandboxStartError(this.reason('SANDBOX_HOST_EXITED')));
    for (const [id, cmd] of this.pending) {
      this.pending.delete(id);
      cmd.stdout.end();
      cmd.stderr.end();
      cmd.resolve(
        cmd.killRequested
          ? { kind: 'signal' }
          : { kind: 'error', message: this.reason('SANDBOX_CONTAINER_EXITED') },
      );
    }
  }

  /** La première connexion qui présente le jeton est celle de l'hôte ; toute autre est fermée. */
  private accept(sock: Socket): void {
    if (this.socket || this.dead) {
      sock.destroy();
      return;
    }
    sock.setEncoding('utf8');
    let buffer = '';
    let greeted = false;
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let m: HostMessage;
        try {
          m = JSON.parse(line) as HostMessage;
        } catch {
          continue;
        }
        if (!greeted) {
          if (m.hello !== this.token) {
            sock.destroy();
            return;
          }
          greeted = true;
          this.socket = sock;
          // La connexion perdue, l'hôte s'arrête : le conteneur est fini.
          sock.on('close', () => this.container.kill());
          this.onSocketReady?.();
          continue;
        }
        this.handle(m);
      }
    });
    sock.on('error', () => undefined);
  }

  private onSocketReady: (() => void) | null = null;

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
      this.onSocketReady = () => this.send({ op: 'init', env });
      if (this.dead)
        this.readyWaiter.reject(new SandboxStartError(this.reason('SANDBOX_HOST_EXITED')));
    });
    this.readyWaiter = null;
  }

  private send(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
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
      if (cmd.killRequested) killTreeFromHost(m.started);
    } else if (m.d !== undefined) {
      (m.s === 'e' ? cmd.stderr : cmd.stdout).write(Buffer.from(m.d, 'base64'));
    } else if (m.error !== undefined || 'exit' in m) {
      this.pending.delete(m.id);
      cmd.stdout.end();
      cmd.stderr.end();
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
    if (this.dead || !this.socket) {
      throw new SandboxStartError(this.reason('SANDBOX_CONTAINER_EXITED'));
    }
    const id = ++this.nextId;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolve!: (end: ProcessEnd) => void;
    const done = new Promise<ProcessEnd>((r) => (resolve = r));
    const cmd: PendingCommand = { stdout, stderr, pid: null, killRequested: false, resolve };
    this.pending.set(id, cmd);
    const parts = windowsSpawnParts(launch.target, comspecOf(launch.env));
    this.send({ op: 'run', id, ...parts, cwd: launch.cwd, env: definedEnv(launch.env) });
    return {
      stdout,
      stderr,
      done,
      kill: () => {
        if (cmd.killRequested) return;
        cmd.killRequested = true;
        if (cmd.pid !== null) killTreeFromHost(cmd.pid);
      },
    };
  }

  async close(): Promise<void> {
    if (!this.dead) {
      this.socket?.destroy();
      this.container.kill();
    }
    await this.exited;
  }
}

/**
 * Le backend MXC. `load` est injectable pour les tests (un SDK absent, un SDK
 * qui refuse) ; par défaut, le vrai paquet.
 */
export function mxcBackend(
  load: () => Promise<MxcModule> = () => import('@microsoft/mxc-sdk/v1'),
): SandboxBackend {
  let mod: Promise<MxcModule> | undefined;
  const sdk = (): Promise<MxcModule> => (mod ??= load());
  // Les conteneurs sont tenus par le courtier, hors du runner (mxc-broker.ts
  // dit pourquoi). Il résout le SDK lui-même, depuis CE module : le même
  // paquet que celui que le runner charge. Rien n'est résolu ici, où un
  // bundler (le build du web) lirait la résolution et voudrait l'embarquer.
  let brokerClient: MxcBroker | undefined;
  const broker = (): MxcBroker => (brokerClient ??= new MxcBroker(fileURLToPath(import.meta.url)));

  const openContainer = async (
    writableRoots: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<JobContainer> => {
    try {
      await sdk();
    } catch (e) {
      throw new SandboxStartError(messageOf(e));
    }
    const environment = definedEnv(env);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const token = randomBytes(24).toString('hex');
    let opened: BrokeredContainer;
    try {
      opened = await broker().open(
        hostRequest(ensureJobHostScript(), port, token, writableRoots, environment),
      );
    } catch (e) {
      server.close();
      throw e instanceof SandboxStartError ? e : new SandboxStartError(messageOf(e));
    }
    const container = new MxcJobContainer(opened, server, token);
    try {
      await container.init(environment);
    } catch (e) {
      await container.close();
      throw e instanceof SandboxStartError ? e : new SandboxStartError(messageOf(e));
    }
    return container;
  };

  const probe = async (): Promise<SandboxStatus> => {
    let m: MxcModule;
    try {
      m = await sdk();
    } catch (e) {
      return { state: 'unavailable', code: 'SANDBOX_BACKEND_MISSING', reason: messageOf(e) };
    }
    try {
      const support = m.getPlatformSupport();
      if (!support.isSupported) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_PLATFORM_UNSUPPORTED',
          reason: support.reason || 'getPlatformSupport: isSupported=false',
        };
      }
      // LE PALIER D'ISOLATION. Seul `base-container` est accepté, parce que
      // c'est le seul MESURÉ sain (Windows 11 Home 25H2, essai #731 et ce
      // PR). Sur le palier `appcontainer-dacl` (runner Windows Server 2025 de
      // GitHub, mesuré le 14/10), déclarer les lecteurs en lecture fait
      // RÉÉCRIRE par MXC les ACL de tout le lecteur C: : 820 s pour la
      // première commande, 159 s pour la suivante, et des commandes
      // parallèles refusées au bout de 30 s (`timed out acquiring DACL mutex
      // on \\?\C:\`). Confiner à ce prix, en touchant aux droits de chaque
      // fichier de l'utilisateur, n'est pas un mode dégradé acceptable : le
      // bac à sable se dit indisponible, avec le palier et les avertissements
      // de MXC cités tels quels.
      if (support.isolationTier !== ACCEPTED_TIER) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_PLATFORM_UNSUPPORTED',
          reason: [
            `isolationTier=${support.isolationTier ?? 'unknown'}`,
            ...(support.isolationWarnings ?? []),
          ].join(' | '),
        };
      }
    } catch (e) {
      return { state: 'unavailable', code: 'SANDBOX_PLATFORM_UNSUPPORTED', reason: messageOf(e) };
    }
    // L'épreuve : un conteneur ouvert pour de vrai, une commande triviale,
    // fermé. Elle attrape ce qu'aucune sonde déclarative ne voit — un Node
    // trop ancien pour les flux natifs du SDK (« native stdio on Windows
    // requires Node.js 24.21.0 … or 26.8.0 », mesuré sur Node 26.4), une DLL
    // qui ne s'initialise pas, des binaires manquants.
    // LOCALAPPDATA : MXC refuse un environnement qui ne le porte pas
    // (`policy_validation … missing the required variable(s): LOCALAPPDATA`).
    const env: Record<string, string | undefined> = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[name] = process.env[name];
    }
    let container: JobContainer | null = null;
    try {
      container = await openContainer([], env);
      const proc = await container.start({
        target: { command: 'exit 0' },
        cwd: process.env['SYSTEMROOT'] ?? 'C:\\Windows',
        env,
      });
      proc.stdout?.resume();
      proc.stderr?.resume();
      const end = await proc.done;
      if (end.kind !== 'exit' || end.exitCode !== 0) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_SELF_TEST_FAILED',
          reason:
            end.kind === 'exit'
              ? `exit ${end.exitCode}`
              : end.kind === 'error'
                ? end.message
                : 'signal',
        };
      }
    } catch (e) {
      const reason = e instanceof SandboxStartError ? e.backendMessage : messageOf(e);
      return { state: 'unavailable', code: 'SANDBOX_SELF_TEST_FAILED', reason };
    } finally {
      await container?.close();
    }
    return { state: 'available', backend: MXC_BACKEND_NAME };
  };

  return { probe, openContainer };
}
