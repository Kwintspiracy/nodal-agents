// cluster-lock.ts — UN SEUL démarrage de cluster Postgres à la fois, sur toute
// la machine (issue #130).
//
// ## Pourquoi un verrou de FICHIER, et pas un réglage vitest
//
// `pnpm test` passe par turbo, qui lance un `vitest run` PAR PAQUET, tous en
// même temps. `fileParallelism: false` ne sérialise que les fichiers d'UN
// paquet : apps/cli l'a depuis 2026-08-21 et cela n'a rien changé au défaut
// observé, parce que les autres démarrages venaient d'apps/runner et de
// packages/db, dans d'AUTRES processus. Le 16/09, sur `pnpm release:check`,
// jusqu'à cinq clusters réels s'initialisaient à la même seconde et
// `postgres-auth-stop.pg.test.ts` a dépassé ses 120 s deux fois de suite —
// alors qu'il passe seul en quelques secondes, et sur la CI.
//
// Trois processus sans lien de parenté ne partagent qu'une chose : le système
// de fichiers. D'où ce verrou. `mkdir` est la primitive : sa création est
// atomique sur tous les systèmes visés, là où « lire puis écrire » ne l'est sur
// aucun.
//
// ## Ce qu'il sérialise, et ce qu'il ne sérialise PAS
//
// Le DÉMARRAGE seulement — `initdb`, `start`, et l'attente de la première
// connexion. C'est là que le coût est, et c'est la seule section que le budget
// de 120 s mesure. Une suite qui garde ensuite son cluster ouvert pendant toute
// sa durée ne bloque personne : trois postmasters qui tournent côte à côte ne
// coûtent presque rien, trois `initdb` simultanés coûtent la machine.
//
// ## Ce qu'il ne fait pas, délibérément
//
// Il ne vole JAMAIS le verrou d'un processus vivant, et il n'EXCLUT pas
// absolument : passé `LOCK_WAIT_BUDGET_MS`, un candidat démarre quand même, en
// l'écrivant. Une exclusion stricte a été essayée le 18/09 et elle est PIRE que
// le défaut d'origine — un seul démarrage lent gardait le verrou et faisait
// tomber, l'un après l'autre, les budgets de tous les autres fichiers. Ce
// module est donc un contrôle d'admission, pas une garantie ; voir
// `LOCK_WAIT_BUDGET_MS`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Le dossier qui SERT de verrou. Un seul pour toute la machine : deux suites
 * qui choisiraient deux dossiers ne se verraient pas, ce qui est exactement le
 * défaut qu'on répare.
 */
export const CLUSTER_LOCK_DIR: string = join(tmpdir(), 'nodal-agents-pg-start.lock');

/** Le fichier posé DANS le verrou, qui dit qui le tient. */
export const HOLDER_FILE = 'holder.json';

/**
 * Combien de temps un candidat attend le verrou — puis DÉMARRE QUAND MÊME.
 *
 * C'est le point le plus important de ce module, et il a été payé : une
 * exclusion STRICTE est pire que le défaut qu'elle répare. Mesuré le 18/09 sur
 * ce dépôt : un démarrage qui traîne garde le verrou, tous les autres
 * s'alignent derrière lui, et leurs budgets de 120 s tombent les uns après les
 * autres — un seul cluster lent devient trois fichiers rouges. Le verrou n'est
 * donc pas une garantie de correction, c'est un CONTRÔLE D'ADMISSION : il
 * évite les cinq `initdb` simultanés du cas ordinaire, et il s'efface plutôt
 * que de prendre la suite en otage.
 *
 * Ce n'est pas un repli silencieux (invariant #4) : le renoncement écrit
 * `PG_CLUSTER_START_UNSERIALISED` avec l'attente et le détenteur. Et il ne
 * cache aucun échec — le démarrage a lieu, le test fait son travail ; ce qui
 * est perdu est l'optimisation, pas la preuve.
 *
 * La valeur tient sous le budget des cas qui démarrent un cluster (120 s) avec
 * de la marge pour le démarrage lui-même.
 */
export const LOCK_WAIT_BUDGET_MS = 45_000;

/**
 * L'âge à partir duquel un verrou dont on ne peut PAS lire le détenteur est
 * considéré comme abandonné.
 *
 * Il ne s'applique qu'à ce cas-là — un `holder.json` illisible, tronqué, ou
 * jamais écrit parce que le processus est mort entre le `mkdir` et l'écriture.
 * Un détenteur qu'on peut lire ET qui est vivant garde son verrou quel que soit
 * son âge : lui en prendre un sur un critère de durée, c'est deux `initdb` en
 * même temps, donc le défaut d'origine.
 */
export const LOCK_STALE_AFTER_MS = 10 * 60_000;

/** Intervalle entre deux tentatives d'acquisition. */
const POLL_MS = 150;

/** Ce que le détenteur du verrou déclare. */
export interface LockHolder {
  pid: number;
  /** Ce qu'il démarre, pour que l'expiration nomme quelque chose de lisible. */
  label: string;
  /** Quand il a pris le verrou, en millisecondes epoch. */
  at: number;
}

/** Le pid est-il ÉTABLI comme disparu ? Faux dès qu'on ne peut pas conclure. */
function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Ce que le verrou dit de son détenteur, ou `null` quand il ne dit rien de
 * lisible. Exporté pour être éprouvé sans démarrer quoi que ce soit.
 */
export function readHolder(lockDir: string = CLUSTER_LOCK_DIR): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, HOLDER_FILE), 'utf-8')) as unknown;
    if (raw === null || typeof raw !== 'object') return null;
    const { pid, label, at } = raw as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      label: typeof label === 'string' ? label : '',
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ce verrou est-il ABANDONNÉ ? La seule décision de ce module, sortie ici pour
 * être éprouvée sans système de fichiers ni processus.
 *
 * Deux cas, et deux seulement :
 *   - le détenteur se lit, et son pid est établi comme disparu ;
 *   - le détenteur ne se lit PAS, et le verrou est plus vieux que
 *     `LOCK_STALE_AFTER_MS`.
 *
 * Un détenteur vivant n'est jamais abandonné, si vieux soit-il. Voir le
 * commentaire de `LOCK_STALE_AFTER_MS`.
 */
export function lockIsAbandoned(input: {
  holder: LockHolder | null;
  ageMs: number;
  isRunning: (pid: number) => boolean;
}): boolean {
  if (input.holder === null) return input.ageMs > LOCK_STALE_AFTER_MS;
  return !input.isRunning(input.holder.pid);
}

/** Depuis quand ce verrou existe, en millisecondes. `Infinity` s'il a disparu. */
function lockAgeMs(lockDir: string, now: number): number {
  try {
    return now - statSync(lockDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Prend le verrou, ou rend `false` s'il est déjà tenu. Un verrou abandonné est
 * retiré puis repris dans le même appel.
 */
function tryAcquire(lockDir: string, label: string): boolean {
  try {
    mkdirSync(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const now = Date.now();
    const abandoned = lockIsAbandoned({
      holder: readHolder(lockDir),
      ageMs: lockAgeMs(lockDir, now),
      isRunning: pidIsRunning,
    });
    if (!abandoned) return false;
    // Retiré, puis repris — jamais « réutilisé sur place » : entre les deux, un
    // autre candidat doit pouvoir gagner la course du `mkdir`, sans quoi deux
    // processus se croiraient tous les deux détenteurs.
    rmSync(lockDir, { recursive: true, force: true });
    try {
      mkdirSync(lockDir);
    } catch {
      return false;
    }
  }
  const holder: LockHolder = { pid: process.pid, label, at: Date.now() };
  writeFileSync(join(lockDir, HOLDER_FILE), JSON.stringify(holder), 'utf-8');
  installReleaseOnExit();
  held.add(lockDir);
  return true;
}

/** Rend le verrou, et seulement s'il est encore le nôtre. */
function release(lockDir: string): void {
  held.delete(lockDir);
  const holder = readHolder(lockDir);
  // `null` : notre `holder.json` a disparu sous nos pieds. Le dossier reste
  // alors en place ; il expirera par l'âge plutôt que d'être retiré à l'aveugle.
  if (holder === null || holder.pid !== process.pid) return;
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Les verrous que CE processus tient. Rendus à la sortie, quelle qu'elle soit :
 * un worker vitest tué sur un dépassement de budget ne repasse jamais par le
 * `finally` de son démarrage, et son verrou resterait posé jusqu'à ce qu'un
 * autre le déclare abandonné.
 */
const held = new Set<string>();
let releaseOnExitInstalled = false;

function installReleaseOnExit(): void {
  if (releaseOnExitInstalled) return;
  releaseOnExitInstalled = true;
  process.on('exit', () => {
    for (const dir of [...held]) {
      try {
        release(dir);
      } catch {
        /* un verrou qu'on n'a pas pu rendre expirera de lui-même */
      }
    }
  });
}

/**
 * La file INTERNE au processus.
 *
 * Sans elle, deux appels concurrents du même processus se disputeraient le
 * `mkdir` — et le perdant verrait un détenteur VIVANT (lui-même) qu'il
 * n'abandonnerait jamais, donc une attente jusqu'à l'expiration. Les fichiers
 * d'un même paquet arrivent exactement comme ça quand `fileParallelism` n'est
 * pas désactivé.
 */
let inProcessQueue: Promise<unknown> = Promise.resolve();

/** Le verrou est-il tenu par CE processus en ce moment ? Pour les tests. */
export function lockDirOf(): string {
  return CLUSTER_LOCK_DIR;
}

/**
 * Au-delà de cette attente, le verrou DIT qui l'a fait attendre, et combien.
 *
 * Sans cette ligne, un fichier qui dépasse son budget ne dit pas s'il a passé
 * son temps à démarrer un cluster ou à attendre celui d'un autre paquet — et
 * c'est exactement la question qu'on se pose en lisant l'issue #130. Un code,
 * pas une phrase (invariant #2).
 */
const WAIT_WORTH_SAYING_MS = 1_000;

/** Comment ce démarrage a obtenu — ou non — sa place. */
function describe(holder: LockHolder | null): string {
  return holder === null ? 'unreadable' : `${holder.label} (pid ${holder.pid})`;
}

async function acquireAndRun<T>(
  lockDir: string,
  label: string,
  start: () => Promise<T>,
  budgetMs: number,
): Promise<T> {
  const began = Date.now();
  const deadline = began + budgetMs;
  let blockedBy: LockHolder | null = null;
  let acquired = false;
  for (;;) {
    if (tryAcquire(lockDir, label)) {
      acquired = true;
      break;
    }
    blockedBy = readHolder(lockDir) ?? blockedBy;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const waited = Date.now() - began;
  if (!acquired) {
    // Le renoncement, dit à voix haute. On démarre quand même : voir
    // `LOCK_WAIT_BUDGET_MS` pour pourquoi une exclusion stricte est pire.
    process.stderr.write(
      `PG_CLUSTER_START_UNSERIALISED label=${label} waitedMs=${waited} blockedBy=${describe(blockedBy)}\n`,
    );
  } else if (waited >= WAIT_WORTH_SAYING_MS) {
    process.stderr.write(
      `PG_CLUSTER_START_WAITED label=${label} waitedMs=${waited} blockedBy=${describe(blockedBy)}\n`,
    );
  }

  const startedAt = Date.now();
  try {
    return await start();
  } finally {
    process.stderr.write(
      `PG_CLUSTER_START_DONE label=${label} serialised=${String(acquired)} ` +
        `waitedMs=${waited} startMs=${Date.now() - startedAt}\n`,
    );
    if (acquired) release(lockDir);
  }
}

/**
 * Démarre un cluster sous le verrou de la machine.
 *
 * `label` ne sert qu'au diagnostic : c'est ce qu'une expiration nomme.
 */
export function withPostgresClusterStart<T>(
  label: string,
  start: () => Promise<T>,
  lockDir: string = CLUSTER_LOCK_DIR,
  budgetMs: number = LOCK_WAIT_BUDGET_MS,
): Promise<T> {
  const attempt = (): Promise<T> => acquireAndRun(lockDir, label, start, budgetMs);
  const run = inProcessQueue.then(attempt, attempt);
  // La file ne porte JAMAIS le rejet : un démarrage qui échoue ne doit pas
  // faire tomber celui qui attend derrière lui.
  inProcessQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
