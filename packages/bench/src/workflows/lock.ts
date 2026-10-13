// workflows/lock.ts — un seul banc à la fois sur une stack.
//
// Au démarrage, le banc annule les essais du banc restés vivants : un banc
// interrompu (coupure, crash) a pu en laisser un. Sans verrou, ce nettoyage
// tuait aussi l'essai VIVANT d'un autre banc (une commande à la main pendant la
// tâche de nuit). Le verrou dit qui mesure la stack ; le nettoyage ne se fait
// qu'une fois le verrou pris, et un second banc refuse de démarrer en disant
// qui le tient — il n'attend pas en silence.
//
// ## Pourquoi un fichier, et pas un verrou consultatif Postgres
//
// `pg_try_advisory_lock` est tenu par UNE connexion. Le banc parle à la base par
// un pool postgres-js, dont chaque connexion est recyclée au bout de 30 à
// 60 minutes (`max_lifetime`, défaut de postgres-js) — moins que le budget du
// scénario le plus long (40 min). Le verrou tomberait alors sans que personne
// le sache ; un redémarrage de la stack le ferait tomber aussi. Le fichier, lui,
// ne tombe que quand son détenteur meurt, et cela se VÉRIFIE (le PID).
//
// Il vit à côté de la configuration de la stack (`~/.nodalai/`), que le banc lit
// pour trouver sa base : c'est donc la portée de la stack elle-même.
//
// ## Ce qu'il garantit
//
// - La création est atomique : le contenu est écrit dans un fichier à part,
//   puis lié sous le nom du verrou (`link` échoue si le nom existe, sous
//   Windows comme sous Linux). Aucun lecteur ne voit jamais un verrou à moitié
//   écrit.
// - Un détenteur mort (PID absent) est remplacé, et c'est dit. La reprise
//   déplace le verrou mort sous un nom unique (atomique : un seul candidat y
//   parvient) et vérifie que c'est bien lui qu'elle a déplacé ; sinon elle le
//   remet et recommence.
// - Un PID réutilisé par un autre programme fait passer un verrou mort pour
//   vivant : le banc refuse alors, en nommant le fichier. C'est le sens sûr :
//   il n'annule jamais l'essai d'un banc vivant.

import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const BENCH_LOCK_FILE = join(homedir(), '.nodalai', 'bench', 'workflows.lock');

const HolderSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  argv: z.string(),
  token: z.string(),
});
type Holder = z.infer<typeof HolderSchema>;

export interface BenchLock {
  readonly path: string;
  /** Retire le verrou s'il est encore le nôtre ; sans effet sinon, et rejouable. */
  release(): void;
}

/** Le processus existe-t-il ? `kill(pid, 0)` n'envoie rien : il teste, sous Windows comme sous Linux. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : il existe, mais appartient à un autre utilisateur.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
}

function parseHolder(raw: string): Holder | null {
  try {
    const r = HolderSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export interface LockOptions {
  /** Le PID de ce banc (défaut : ce processus). */
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly log?: (line: string) => void;
}

/** Prend le verrou, ou lève `workflow_bench_busy` si un banc vivant le tient. */
export function acquireBenchLock(path: string, opts: LockOptions = {}): BenchLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const log = opts.log ?? (() => undefined);
  const mine: Holder = {
    pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2).join(' '),
    token: randomUUID(),
  };
  const content = JSON.stringify(mine);
  mkdirSync(dirname(path), { recursive: true });

  const lock: BenchLock = {
    path,
    release() {
      const raw = readOrNull(path);
      if (raw !== null && parseHolder(raw)?.token === mine.token) unlinkSync(path);
    },
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${path}.${pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, content);
    try {
      linkSync(tmp, path);
      return lock;
    } catch (e) {
      if (code(e) !== 'EEXIST') throw e;
    } finally {
      unlinkSync(tmp);
    }

    const raw = readOrNull(path);
    if (raw === null) continue; // libéré entre-temps : on retente
    const holder = parseHolder(raw);
    if (!holder) {
      throw new Error(
        `workflow_bench_lock_unreadable: ${path} is not a bench lock; if no workflow bench is running, delete it`,
      );
    }
    if (holder.pid !== pid && isAlive(holder.pid)) {
      throw new Error(
        `workflow_bench_busy: another workflow bench is running on this stack (pid ${holder.pid}, started ${holder.startedAt}${holder.argv ? `, args: ${holder.argv}` : ''}). ` +
          `It holds ${path}. Wait for it to finish: two benches on one stack would cancel each other's trials.`,
      );
    }

    // Le détenteur est mort : reprendre SON verrou, et seulement le sien.
    const aside = `${path}.stale-${pid}-${randomUUID()}`;
    try {
      renameSync(path, aside);
    } catch (e) {
      if (code(e) === 'ENOENT') continue; // un autre candidat l'a déplacé avant nous
      throw e;
    }
    if (readFileSync(aside, 'utf8') !== raw) {
      // Déplacé trop tard : c'était le verrou tout neuf d'un autre candidat. Le remettre.
      try {
        linkSync(aside, path);
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
      }
      unlinkSync(aside);
      continue;
    }
    unlinkSync(aside);
    log(
      `took over the bench lock left by a process that is gone (pid ${holder.pid}, started ${holder.startedAt})`,
    );
  }
  throw new Error(`workflow_bench_lock_contended: could not take ${path} after 5 attempts`);
}

export interface ClaimOptions extends LockOptions {
  readonly lockPath: string;
  /** Les têtes d'essai du banc encore vivantes (`readLiveBenchRoots`). */
  liveRoots(): Promise<ReadonlyArray<{ id: string; entityId: string }>>;
  cancel(root: { id: string; entityId: string }): Promise<unknown>;
  log(line: string): void;
}

/**
 * Prend la stack pour ce banc : le verrou D'ABORD, puis l'annulation des essais
 * qu'un banc mort a laissés vivants. Verrou pris, un essai vivant du banc ne
 * peut être à personne d'autre. Un nettoyage qui échoue rend le verrou.
 */
export async function claimStack(o: ClaimOptions): Promise<BenchLock> {
  const lock = acquireBenchLock(o.lockPath, { pid: o.pid, isAlive: o.isAlive, log: o.log });
  try {
    for (const orphan of await o.liveRoots()) {
      await o.cancel(orphan);
      o.log(`cancelled a run left alive by an earlier bench: ${orphan.id}`);
    }
    return lock;
  } catch (e) {
    lock.release();
    throw e;
  }
}

export type TrialSweep = Pick<ClaimOptions, 'liveRoots' | 'cancel' | 'log'>;

/**
 * À l'arrêt (Ctrl+C, SIGTERM) : annule TOUS les essais du banc encore vivants,
 * lus en base avec leur espace. Juste après le lancement, le banc ne connaît
 * que l'id du job (`run_task` ne rend rien d'autre) ; attendre de connaître son
 * espace laissait une fenêtre où l'arrêt sortait sans rien annuler. La base, elle,
 * le connaît. Verrou tenu, ces essais ne peuvent être qu'à ce banc ; sans
 * verrou (arrêté avant de l'avoir pris), aucun essai n'est à lui : il n'en
 * annule aucun.
 */
export async function stopOwnTrials(lock: BenchLock | null, o: TrialSweep): Promise<void> {
  if (lock === null) return;
  for (const root of await o.liveRoots()) {
    await o.cancel(root);
    o.log(`cancelled run ${root.id}`);
  }
}

/**
 * L'arrêt du banc, partagé entre la boucle des essais et le gestionnaire de
 * signal. Balayer UNE fois ne suffit pas : un `run_task` en vol au moment du
 * signal crée son job juste après, et la boucle pourrait en lancer un autre
 * (fin d'un essai, attente, préparation du suivant). Donc, dans cet ordre :
 * plus aucun lancement ; le lancement en vol est attendu, dans une limite ;
 * puis le balayage de tous les essais vivants (`stopOwnTrials`).
 */
export class BenchStop {
  private stopping = false;
  private inFlight: Promise<unknown> | null = null;

  get stopped(): boolean {
    return this.stopping;
  }

  /** Lance un essai (`run_task`), sauf si l'arrêt est demandé ; retient l'appel en vol. */
  async start<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      throw new Error('workflow_stopped: the bench is stopping, no new trial starts');
    }
    const p = run();
    this.inFlight = p;
    try {
      return await p;
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }

  async stop(lock: BenchLock | null, sweep: TrialSweep, o: { waitMs: number }): Promise<void> {
    this.stopping = true;
    const pending = this.inFlight;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), o.waitMs);
        }),
      ]);
      clearTimeout(timer);
      if (!settled) {
        sweep.log(
          `a run_task call was still in flight after ${o.waitMs} ms; if it created a job, the next bench cancels it before it starts`,
        );
      }
    }
    await stopOwnTrials(lock, sweep);
  }
}
