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
//     écritures. Internet et le réseau local répondent ; la boucle locale de
//     la MACHINE (127.0.0.1, ::1, et l'adresse de la machine elle-même), non :
//     un conteneur en est exclu par défaut (`EACCES` mesuré le 15/10 sur
//     Windows 11 26200.9711, `ETIMEDOUT` sur l'image windows-11-arm), et
//     l'option MXC qui l'ouvre (`ingress.hostLoopback`) manque à certains
//     builds (26200.9457 : « not supported by this version of Windows »).
//     Une commande confinée ne joint donc pas un service de la machine
//     (ComfyUI, Ollama) ; la boucle locale DU conteneur, elle, marche (un
//     serveur lancé par une commande du job répond à la suivante) ;
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
import { existsSync } from 'node:fs';
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
  writableRoots: readonly string[],
  environment: Record<string, string>,
): ContainerRequest {
  return {
    command: `"${process.execPath}" "${script}"`,
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
 * Le conteneur d'un job : un hôte MXC, joint par ses flux standard que le
 * courtier relaie (job-host.ts dit pourquoi), et les commandes qu'il porte.
 */
class MxcJobContainer implements JobContainer {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private dead = false;
  private hostOutput = '';
  private buffer = '';
  private readonly exited: Promise<void>;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly container: BrokeredContainer) {
    container.onOutput((chunk) => this.receive(chunk));
    // Ce que la racine du conteneur a écrit sur sa sortie d'erreur (une panne
    // de Node au démarrage de l'hôte) arrive avec son arrêt, par le courtier —
    // cité, borné. Une panne de l'hôte plus tard arrive par le canal (`fatal`).
    this.exited = container.exited.then((r) => {
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
      cmd.resolve(
        cmd.killRequested
          ? { kind: 'signal' }
          : { kind: 'error', message: this.reason('SANDBOX_CONTAINER_EXITED') },
      );
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
    this.container.write(`${JSON.stringify(message)}\n`);
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
    if (this.dead) {
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
    if (!this.dead) this.container.kill();
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
    let opened: BrokeredContainer;
    try {
      opened = await broker().open(hostRequest(ensureJobHostScript(), writableRoots, environment));
    } catch (e) {
      throw e instanceof SandboxStartError ? e : new SandboxStartError(messageOf(e));
    }
    const container = new MxcJobContainer(opened);
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
