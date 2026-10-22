// job-scope.ts — la DURÉE DE VIE des processus qu'un job lance (#628, #750,
// #755).
//
// Décision du propriétaire (14/10) : un processus qu'une commande laisse
// tourner — un serveur de dev, ComfyUI, `start /b …` — vit jusqu'à la FIN DU
// JOB, puis Nodal le tue, quelle que soit la fin : succès, échec, Stop,
// annulation, job perdu, arrêt du runner. Il n'est PAS tué à la fin de la
// commande : la commande suivante du même job doit pouvoir le joindre.
//
// La forme générale : UN périmètre par job, qui porte TOUT ce que le job lance
// — les commandes de ses outils (`run_command`, `run_skill_script`, les
// commandes de preuve, `code_task`), le CLI d'un runtime —, et que le runner
// ferme à la fin du job. Deux façons d'y lancer un processus, un seul geste de
// fermeture :
//   - confiné (`container`) : le conteneur du job (un par jeu de dossiers
//     inscriptibles) ; le fermer tue tout ce qu'il contient ;
//   - hors bac à sable (`startOwned`) — le bac à sable indisponible, ou un
//     programme que l'étape 1 ne confine pas (un CLI) :
//       · Windows : un Job Object par job (#755, host-container.ts) — l'hôte
//         du job y est rangé avant de lancer quoi que ce soit, chaque
//         commande est son enfant, et la fermeture tue tous les membres,
//         détachés compris. Un runner qui MEURT ferme le handle avec lui :
//         le noyau tue les membres ;
//       · Unix : chaque commande est cheffe de son groupe de processus, et
//         porte l'étiquette du job dans son environnement
//         (unix-job-processes.ts) ; la fermeture tue chaque groupe, puis
//         chaque processus étiqueté (un `setsid` a quitté le groupe, pas
//         l'étiquette). Un runner qui meurt laisse ses groupes : le runner qui
//         reprend le job les tue par l'étiquette (`killLeftoversOfJob`).
// Ce qui échappe à chaque forme est dit là où elle vit (windows-job-object.ts,
// unix-job-processes.ts).
//
// Les périmètres de JOB sont rangés par identifiant de job : l'appelant le
// donne (`ctx.jobId`), rien n'est deviné. Un usage qui n'est pas un job (un
// tour de chat, une sonde) ouvre son propre périmètre (`openProcessScope`) et
// le ferme lui-même ; l'arrêt du runner les ferme tous.
//
// Invariant #4 : un processus que la fermeture n'a pas pu tuer est journalisé
// (`JOB_PROCESS_KILL_FAILED`, avec le pid), jamais ignoré.

import { spawn } from 'node:child_process';
import { openJobObjectContainer } from './host-container';
import { DRAIN_MS } from './job-host';
import {
  JOB_PROCESS_KILL_FAILED,
  defaultKillLog,
  killProcessTree,
  type KillLog,
} from './process-tree';
import { defaultSandbox, type Sandbox } from './status';
import type { CommandLaunch, JobContainer, ProcessEnd, StartedProcess } from './types';
import { JOB_SCOPE_ENV, killTaggedProcesses } from './unix-job-processes';

/** Ce que le périmètre fait des processus hors bac à sable, selon l'OS. */
export interface OwnedProcessOptions {
  /** L'OS dont la forme s'applique (défaut : celui du runner). */
  platform?: NodeJS.Platform;
  log?: KillLog;
  /** Injectable pour les tests : le conteneur Windows hors bac à sable. */
  openOwnedContainer?: typeof openJobObjectContainer;
}

/** Tous les périmètres vivants de ce processus, de job ou non : l'arrêt du runner les ferme. */
const live = new Set<JobProcessScope>();

export class JobProcessScope {
  private readonly containers = new Map<string, Promise<JobContainer>>();
  /** Windows : le conteneur hors bac à sable du job (son Job Object). */
  private owned: Promise<JobContainer> | null = null;
  /** Unix : les groupes de processus des commandes hors bac à sable. */
  private readonly groups = new Set<number>();
  private closed = false;
  private readonly platform: NodeJS.Platform;
  private readonly log: KillLog;
  private readonly openOwned: typeof openJobObjectContainer;

  constructor(
    /** L'identifiant du job (ou d'un usage ponctuel : une sonde, un tour de chat, un test). */
    readonly id: string,
    /** Le bac à sable sous lequel les commandes de ce périmètre tournent. */
    readonly sandbox: Sandbox = defaultSandbox(),
    opts: OwnedProcessOptions = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.log = opts.log ?? defaultKillLog;
    this.openOwned = opts.openOwnedContainer ?? openJobObjectContainer;
    live.add(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`JOB_SCOPE_CLOSED: ${this.id}`);
  }

  /**
   * Le conteneur du job pour ces dossiers inscriptibles, ouvert à la première
   * commande. Un conteneur mort de lui-même (son hôte tué de l'extérieur) est
   * fermé puis remplacé : ce qu'il portait est perdu, et la commande suivante
   * repart dans un conteneur neuf plutôt que d'échouer pour toujours.
   */
  async container(
    writableRoots: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    /** Dossiers à pouvoir lire sous un dossier refusé (voir `openContainer`). */
    readableRoots: readonly string[] = [],
  ): Promise<JobContainer> {
    this.assertOpen();
    const backend = this.sandbox.backend;
    if (!backend) throw new Error('SANDBOX_BACKEND_ABSENT');
    const key = `${[...writableRoots].sort().join('\n')}\u0000${[...readableRoots].sort().join('\n')}`;
    const existing = this.containers.get(key);
    if (existing) {
      const c = await existing.catch(() => null);
      if (c?.alive) return c;
      this.containers.delete(key);
      await c?.close();
    }
    const opening = backend.openContainer(writableRoots, env, readableRoots);
    this.containers.set(key, opening);
    try {
      return await this.keptOpen(opening);
    } catch (e) {
      this.containers.delete(key);
      throw e;
    }
  }

  /** Un conteneur ouvert pendant que le périmètre se fermait : rien ne doit lui survivre. */
  private async keptOpen(opening: Promise<JobContainer>): Promise<JobContainer> {
    const c = await opening;
    if (this.closed) {
      await c.close();
      this.assertOpen();
    }
    return c;
  }

  /**
   * Lance un processus HORS bac à sable, possédé par le job : il meurt à la
   * fermeture du périmètre, lui et tout ce qu'il lance. Sous Windows, il
   * passe par l'hôte du Job Object du job ; LÈVE `SandboxStartError`
   * (`JOB_OBJECT_FAILED: …`) quand ce job ne peut pas être tenu — rien n'est
   * alors lancé hors de lui.
   */
  async startOwned(launch: CommandLaunch): Promise<StartedProcess> {
    this.assertOpen();
    if (this.platform !== 'win32') return this.spawnInGroup(launch);
    const existing = await this.owned?.catch(() => null);
    if (existing && !existing.alive) {
      this.owned = null;
      await existing.close();
    }
    if (!this.owned) {
      const opening = this.openOwned({ jobId: this.id, env: launch.env, log: this.log });
      this.owned = opening;
      opening.catch(() => {
        if (this.owned === opening) this.owned = null;
      });
    }
    const c = await this.keptOpen(this.owned);
    return c.start(launch);
  }

  /**
   * Unix : la commande est cheffe de son groupe (`detached`), et porte
   * l'étiquette du job. Elle finit à la sortie de son processus racine, ses
   * flux vidés au plus DRAIN_MS : un processus d'arrière-plan qui hérite du
   * tuyau ne la retient pas.
   */
  private spawnInGroup(launch: CommandLaunch): StartedProcess {
    const env = { ...launch.env, [JOB_SCOPE_ENV]: this.id } as unknown as NodeJS.ProcessEnv;
    const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [
      launch.stdin === 'pipe' ? 'pipe' : 'ignore',
      'pipe',
      'pipe',
    ];
    const common = { cwd: launch.cwd, detached: true, env, stdio };
    const target = launch.target;
    const child =
      'command' in target
        ? spawn(target.command, { ...common, shell: true })
        : spawn(target.file, [...target.args], { ...common, shell: false });
    if (child.pid !== undefined) this.groups.add(child.pid);
    child.stdin?.on('error', () => undefined);
    const done = new Promise<ProcessEnd>((resolve) => {
      child.on('error', (e: Error) => resolve({ kind: 'error', message: e.message }));
      child.on('exit', (code: number | null) => {
        const end: ProcessEnd =
          code === null ? { kind: 'signal' } : { kind: 'exit', exitCode: code };
        const drained = setTimeout(() => resolve(end), DRAIN_MS);
        child.once('close', () => {
          clearTimeout(drained);
          resolve(end);
        });
      });
    });
    const spawned = new Promise<string | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e: Error) => resolve(e.message));
    });
    let killed = false;
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      spawned,
      kill: () => {
        if (killed) return;
        killed = true;
        void killProcessTree(child.pid, {
          platform: this.platform,
          backstop: () => child.kill('SIGKILL'),
          context: { jobId: this.id },
          log: this.log,
        });
      },
    };
  }

  /** Ferme le périmètre : tout ce que le job a lancé meurt. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    live.delete(this);
    const containers = [...this.containers.values(), ...(this.owned ? [this.owned] : [])];
    this.containers.clear();
    this.owned = null;
    const groups = [...this.groups];
    this.groups.clear();
    await Promise.all([
      ...containers.map(async (p) => {
        const c = await p.catch(() => null);
        await c?.close();
      }),
      ...groups.map((pid) =>
        killProcessTree(pid, {
          platform: this.platform,
          context: { jobId: this.id },
          log: this.log,
        }),
      ),
    ]);
    await killLeftoversOfJob(this.id, this.log, this.platform);
  }
}

/**
 * Tue les processus du job `jobId` qui vivent encore sur cette machine hors de
 * tout groupe et de tout conteneur : ceux que la fermeture de son périmètre a
 * laissés (un `setsid`), ou ceux d'un runner MORT dont un autre runner reprend
 * le job. Sous Unix, par l'étiquette du job. Sous Windows, il n'y a rien à
 * retrouver : le Job Object du job meurt avec le processus qui le tenait, et
 * le noyau tue ses membres (KILL_ON_JOB_CLOSE) ; le conteneur MXC meurt avec
 * son courtier.
 *
 * Un processus étiqueté qui survit est journalisé (`JOB_PROCESS_KILL_FAILED`).
 */
export async function killLeftoversOfJob(
  jobId: string,
  log: KillLog = defaultKillLog,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return;
  const left = await killTaggedProcesses(jobId);
  for (const pid of left ?? []) {
    log(JOB_PROCESS_KILL_FAILED, { pid, how: 'job-tag', jobId });
  }
}

// ─── Le registre des jobs de CE processus ────────────────────────────────────

const scopes = new Map<string, JobProcessScope>();

/**
 * Le périmètre du job `jobId`, ouvert à la première demande — sous le bac à
 * sable de ce processus, ou sous `sandbox` quand celui qui l'ouvre le donne
 * (un test qui veut un bac à sable indisponible). Un périmètre déjà ouvert
 * sous un AUTRE bac à sable est une erreur, jamais un changement en silence.
 */
export function jobProcessScope(jobId: string, sandbox?: Sandbox): JobProcessScope {
  let s = scopes.get(jobId);
  if (!s || s.isClosed) {
    s = new JobProcessScope(jobId, sandbox ?? defaultSandbox());
    scopes.set(jobId, s);
  } else if (sandbox !== undefined && s.sandbox !== sandbox) {
    throw new Error(`JOB_SCOPE_SANDBOX_MISMATCH: ${jobId}`);
  }
  return s;
}

/**
 * Un périmètre qui n'est PAS celui d'un job (un tour de chat, une sonde de
 * diagnostic) : hors du registre des jobs — le balayage des jobs finis ne le
 * voit pas —, fermé par celui qui l'ouvre, et par l'arrêt du runner. `label`
 * nomme l'usage dans les journaux et dans l'étiquette de ses processus : il
 * doit être unique (un uuid dedans).
 */
export function openProcessScope(label: string, sandbox?: Sandbox): JobProcessScope {
  return new JobProcessScope(label, sandbox ?? defaultSandbox());
}

/** Ferme le périmètre d'un job, s'il en a un. Rend `true` s'il y en avait un. */
export async function closeJobProcessScope(jobId: string): Promise<boolean> {
  const s = scopes.get(jobId);
  if (!s) return false;
  scopes.delete(jobId);
  await s.close();
  return true;
}

/** Les jobs qui ont un périmètre ouvert dans ce processus. */
export function openJobProcessScopeIds(): string[] {
  return [...scopes.keys()];
}

/** Ferme TOUS les périmètres, de job ou non : l'arrêt du runner. */
export async function closeAllJobProcessScopes(): Promise<void> {
  scopes.clear();
  await Promise.all([...live].map((s) => s.close()));
}
