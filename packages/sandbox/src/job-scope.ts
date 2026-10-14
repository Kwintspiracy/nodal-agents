// job-scope.ts — la DURÉE DE VIE des processus qu'un job lance (#628).
//
// Décision du propriétaire (14/10) : un processus qu'une commande laisse
// tourner — un serveur de dev, ComfyUI, `start /b …` — vit jusqu'à la FIN DU
// JOB, puis Nodal le tue, quelle que soit la fin : succès, échec, Stop,
// annulation, job perdu, arrêt du runner. Il n'est PAS tué à la fin de la
// commande : la commande suivante du même job doit pouvoir le joindre.
//
// La forme générale : UN périmètre par job, qui porte tout ce que ses
// commandes lancent, et que le runner ferme à la fin du job.
//   - confiné : le conteneur du job (un par jeu de dossiers inscriptibles —
//     les trois appelants de l'étape 1 donnent les mêmes, ceux du job) ;
//     le fermer tue tout ce qu'il contient ;
//   - non confiné (bac à sable indisponible) : les commandes lancées, notées ;
//     sous Unix, chacune est chef de son groupe de processus, et la fermeture
//     tue chaque groupe ; sous Windows, `taskkill /T` sur chaque commande
//     encore vivante — un petit-enfant DÉTACHÉ dont le parent est mort n'y est
//     plus rattaché et survit : seul le conteneur MXC le tient (limite dite).
//
// Les périmètres sont rangés par identifiant de job : l'appelant le donne
// (`ctx.jobId`), rien n'est deviné. Un périmètre fermé est retiré ; un job
// relancé plus tard (un nouvel essai depuis le tableau de bord) en rouvre un.

import { spawn } from 'node:child_process';
import { defaultSandbox, type Sandbox } from './status';
import type { JobContainer } from './types';

/** Un processus non confiné qu'une commande a lancé, tel que la fermeture le tue. */
interface TrackedProcess {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
}

export class JobProcessScope {
  private readonly containers = new Map<string, Promise<JobContainer>>();
  private readonly tracked = new Set<TrackedProcess>();
  private closed = false;

  constructor(
    /** L'identifiant du job (ou d'un usage ponctuel : une sonde, un test). */
    readonly id: string,
    /** Le bac à sable sous lequel les commandes de ce périmètre tournent. */
    readonly sandbox: Sandbox = defaultSandbox(),
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`JOB_SCOPE_CLOSED: ${this.id}`);
  }

  /**
   * Le conteneur du job pour ces dossiers inscriptibles, ouvert à la première
   * commande. Un conteneur mort de lui-même (son hôte tué de l'extérieur) est
   * remplacé : ce qu'il portait est perdu, et la commande suivante repart
   * dans un conteneur neuf plutôt que d'échouer pour toujours.
   */
  async container(
    writableRoots: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<JobContainer> {
    this.assertOpen();
    const backend = this.sandbox.backend;
    if (!backend) throw new Error('SANDBOX_BACKEND_ABSENT');
    const key = [...writableRoots].sort().join('\n');
    const existing = this.containers.get(key);
    if (existing) {
      const c = await existing.catch(() => null);
      if (c?.alive) return c;
      this.containers.delete(key);
    }
    const opening = backend.openContainer(writableRoots, env);
    this.containers.set(key, opening);
    try {
      const c = await opening;
      // Fermé pendant l'ouverture : rien ne doit lui survivre.
      if (this.closed) {
        await c.close();
        this.assertOpen();
      }
      return c;
    } catch (e) {
      this.containers.delete(key);
      throw e;
    }
  }

  /** Note un processus non confiné lancé par une commande de ce job. */
  trackUnconfined(pid: number, platform: NodeJS.Platform = process.platform): void {
    this.assertOpen();
    this.tracked.add({ pid, platform });
  }

  /** Ferme le périmètre : tout ce que les commandes du job ont lancé meurt. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const containers = [...this.containers.values()];
    this.containers.clear();
    const tracked = [...this.tracked];
    this.tracked.clear();
    await Promise.all([
      ...containers.map(async (p) => {
        const c = await p.catch(() => null);
        await c?.close();
      }),
      ...tracked.map((t) => killTracked(t)),
    ]);
  }
}

async function killTracked(t: TrackedProcess): Promise<void> {
  if (t.platform !== 'win32') {
    // `detached: true` a fait de la commande la cheffe de son groupe : le pid
    // négatif vise tout le groupe, arrière-plan compris.
    try {
      process.kill(-t.pid, 'SIGKILL');
    } catch {
      /* groupe déjà vide */
    }
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tk = spawn('taskkill', ['/PID', String(t.pid), '/T', '/F'], { windowsHide: true });
      tk.on('close', () => resolve());
      tk.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

// ─── Le registre des jobs de CE processus ────────────────────────────────────

const scopes = new Map<string, JobProcessScope>();

/** Le périmètre du job `jobId`, ouvert à la première demande. */
export function jobProcessScope(jobId: string): JobProcessScope {
  let s = scopes.get(jobId);
  if (!s || s.isClosed) {
    s = new JobProcessScope(jobId);
    scopes.set(jobId, s);
  }
  return s;
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

/** Ferme TOUS les périmètres : l'arrêt du runner. */
export async function closeAllJobProcessScopes(): Promise<void> {
  await Promise.all([...scopes.keys()].map((id) => closeJobProcessScope(id)));
}
