// cluster-registry.ts — un cluster de test MEURT avec son lanceur (issue #130).
//
// Le 16/09, deux runs de `pnpm test` tués sur un dépassement de budget ont
// laissé TREIZE `postgres.exe` derrière eux, parents morts. Sous Windows, tuer
// un processus ne tue pas ses enfants : un `afterAll` qui ne s'exécute jamais
// ne nettoie rien, et le postmaster survit à la suite qui l'a démarré.
//
// Ce module tient la liste des clusters vivants de CE processus et les arrête
// depuis un gestionnaire de sortie. Il couvre ce qu'un gestionnaire PEUT
// couvrir : une sortie normale, une exception non rattrapée (`exit` s'exécute
// quand même), un Ctrl+C, un `SIGTERM`. Il ne couvre pas — et rien en
// JavaScript ne le peut — un `taskkill /F` sur le processus lui-même : aucun
// code de l'utilisateur ne tourne après celui-là. C'est pour ce reste que
// `startRealPostgres` refuse en plus les ports de l'installation, de sorte
// qu'un survivant ne puisse pas tenir le port du poste de travail.
//
// L'arrêt est SYNCHRONE, parce que `process.on('exit')` n'attend aucune
// promesse : ce qui n'est pas fait avant le retour du gestionnaire n'est jamais
// fait.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Un cluster de test vivant, tel que le registre le retient. */
export interface TestClusterEntry {
  dataDir: string;
  port: number;
  /**
   * Le `pg_ctl` du paquet embarqué, résolu AU DÉMARRAGE.
   *
   * Il est résolu d'avance parce que le résoudre demande un `import()`
   * asynchrone, et qu'un gestionnaire de sortie n'a pas le droit d'attendre.
   * `null` quand la résolution a échoué : on tombe alors sur le signal.
   */
  pgCtl: string | null;
}

/** Ce qu'un arrêt synchrone a réellement fait. */
export type SyncStopOutcome = 'pg_ctl' | 'signal' | 'nothing';

/** Les gestes que `stopClusterSync` emprunte au système, pour être éprouvé sans lui. */
export interface SyncStopDeps {
  /** Le pid inscrit dans `<dataDir>/postmaster.pid`, ou null. */
  postmasterPid: (dataDir: string) => number | null;
  /** `pg_ctl stop -m immediate`. Rend false quand il n'a pas abouti. */
  runPgCtl: (pgCtl: string, dataDir: string) => boolean;
  /** Le dernier recours. Rend false quand le signal n'a pas pu être envoyé. */
  killPostmaster: (pid: number) => boolean;
}

/**
 * Arrête UN cluster, synchronement, dans l'ordre du moins brutal au plus.
 *
 * `-m immediate` et non `-m fast` : un arrêt rapide écrit un point de
 * contrôle, ce qui peut prendre des secondes qu'un gestionnaire de sortie n'a
 * pas. Un cluster de test vit dans un dossier temporaire qui va être supprimé :
 * il n'a aucune donnée à sauver, et sa récupération au démarrage suivant
 * n'arrivera jamais.
 *
 * Le signal reste le dernier recours. Il laisse fuir la section de mémoire
 * partagée Windows — celle qui fait échouer un démarrage suivant sur
 * « pre-existing shared memory block is still in use » — mais cette section est
 * indexée par le DATA DIR, et celui d'un cluster de test est un dossier
 * temporaire unique qui ne resservira pas. Le coût réel est donc nul, là où il
 * serait grave sur l'installation de l'utilisateur.
 */
export function stopClusterSync(entry: TestClusterEntry, deps: SyncStopDeps): SyncStopOutcome {
  const pid = deps.postmasterPid(entry.dataDir);
  if (pid === null) return 'nothing';
  if (entry.pgCtl !== null && deps.runPgCtl(entry.pgCtl, entry.dataDir)) return 'pg_ctl';
  return deps.killPostmaster(pid) ? 'signal' : 'nothing';
}

/** Le pid de la première ligne de `<dataDir>/postmaster.pid`, ou null. */
export function postmasterPidOf(dataDir: string): number | null {
  try {
    const first = readFileSync(join(dataDir, 'postmaster.pid'), 'utf-8').split('\n')[0]?.trim();
    const pid = Number.parseInt(first ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Les gestes réels, ceux que le gestionnaire de sortie utilise. */
export const systemStopDeps: SyncStopDeps = {
  postmasterPid: postmasterPidOf,
  runPgCtl: (pgCtl, dataDir) => {
    try {
      execFileSync(pgCtl, ['stop', '-D', dataDir, '-m', 'immediate', '-w', '-t', '5'], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  },
  killPostmaster: (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },
};

const live = new Set<TestClusterEntry>();
let hooksInstalled = false;

/**
 * Arrête tout ce qui est encore inscrit. Idempotent : une entrée arrêtée est
 * retirée, donc un second appel (sortie après signal) ne fait rien.
 */
export function stopAllTestClustersSync(deps: SyncStopDeps = systemStopDeps): SyncStopOutcome[] {
  const outcomes: SyncStopOutcome[] = [];
  for (const entry of [...live]) {
    live.delete(entry);
    try {
      outcomes.push(stopClusterSync(entry, deps));
    } catch {
      outcomes.push('nothing');
    }
    forgetOnDisk(entry);
  }
  return outcomes;
}

/**
 * Pose les gestionnaires, une seule fois.
 *
 * `exit` couvre la sortie normale ET l'exception non rattrapée — Node exécute
 * ses gestionnaires `exit` après avoir imprimé la trace. Les signaux sont
 * repris explicitement parce qu'ils TERMINENT le processus sans passer par
 * `exit` tant que personne ne les écoute ; les écouter change ce défaut, d'où
 * le `process.exit` qui suit l'arrêt.
 */
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => {
    stopAllTestClustersSync();
  });
  // `SIGBREAK` n'existe que sous Windows (Ctrl+Pause) ; l'écouter ailleurs
  // lève. La liste est filtrée plutôt que devinée.
  const signals: NodeJS.Signals[] =
    process.platform === 'win32'
      ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
      : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.on(signal, () => {
      stopAllTestClustersSync();
      // 128 + le numéro du signal, la convention du shell. On sort NOUS-MÊMES :
      // écouter un signal supprime la terminaison par défaut, et un processus
      // qui survit à son Ctrl+C serait pire que l'orphelin qu'on répare.
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

/** Inscrit un cluster vivant. Rend l'entrée, à passer à `unregisterTestCluster`. */
export function registerTestCluster(entry: TestClusterEntry): TestClusterEntry {
  installHooks();
  reapOnce();
  live.add(entry);
  rememberOnDisk(entry);
  return entry;
}

/** Retire un cluster que son propriétaire a arrêté lui-même. */
export function unregisterTestCluster(entry: TestClusterEntry): void {
  live.delete(entry);
  forgetOnDisk(entry);
}

// ─── Le RAMASSAGE des runs tués (issue #130) ─────────────────────────────────
//
// Un gestionnaire de sortie ne couvre pas tout, et il faut le dire exactement :
// sous Windows, `taskkill /F` sur le processus de test ne laisse tourner AUCUN
// code — ni le nôtre, ni celui d'`embedded-postgres`, qui pose pourtant son
// propre `AsyncExitHook`. C'est précisément ainsi que le 16/09 a laissé treize
// `postgres.exe` derrière lui. Aucune ligne de JavaScript ne peut réparer ça
// DEPUIS le processus qu'on tue.
//
// Elle peut en revanche être réparée par le SUIVANT. Chaque cluster de test
// laisse une fiche sur disque ; au premier démarrage d'un run, les fiches dont
// le propriétaire est mort sont ramassées et leurs clusters arrêtés — par
// `pg_ctl`, donc en relâchant la mémoire partagée que le tir à balle réelle du
// paquet laisse fuir.
//
// Mesuré : c'est ce ramassage, et non le gestionnaire de sortie, qui fait
// disparaître les orphelins d'un run tué de force.

/** Où vivent les fiches. Un dossier, une fiche par cluster. */
export const CLUSTER_REGISTRY_DIR: string = join(tmpdir(), 'nodal-agents-test-clusters');

/** Une fiche, telle qu'elle est écrite. */
export interface ClusterRecord extends TestClusterEntry {
  /** Le processus qui a démarré ce cluster. Mort ⇒ la fiche est ramassable. */
  ownerPid: number;
}

let recordSeq = 0;
const recordPaths = new WeakMap<TestClusterEntry, string>();

function rememberOnDisk(entry: TestClusterEntry): void {
  try {
    mkdirSync(CLUSTER_REGISTRY_DIR, { recursive: true });
    const path = join(CLUSTER_REGISTRY_DIR, `${process.pid}-${recordSeq++}.json`);
    const record: ClusterRecord = { ...entry, ownerPid: process.pid };
    writeFileSync(path, JSON.stringify(record), 'utf-8');
    recordPaths.set(entry, path);
  } catch {
    // Pas de fiche : le ramassage ne verra rien, le gestionnaire de sortie
    // fait toujours son travail. On ne fait pas tomber un test pour ça.
  }
}

function forgetOnDisk(entry: TestClusterEntry): void {
  const path = recordPaths.get(entry);
  if (path === undefined) return;
  recordPaths.delete(entry);
  try {
    rmSync(path, { force: true });
  } catch {
    /* une fiche qui reste sera ramassée quand ce processus sera mort */
  }
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

/** Ce qu'un ramassage a fait d'une fiche. */
export interface ReapedCluster {
  record: ClusterRecord;
  outcome: SyncStopOutcome;
}

/**
 * Arrête les clusters des runs MORTS, et rend ce qui a été fait.
 *
 * Une fiche dont le propriétaire est VIVANT n'est jamais touchée : c'est un
 * autre run en cours, et lui prendre son cluster serait le défaut inverse. Une
 * fiche illisible est laissée en place plutôt que devinée.
 */
export function reapAbandonedTestClusters(
  deps: SyncStopDeps = systemStopDeps,
  dir: string = CLUSTER_REGISTRY_DIR,
  isRunning: (pid: number) => boolean = pidIsRunning,
): ReapedCluster[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const reaped: ReapedCluster[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: ClusterRecord;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ClusterRecord>;
      if (typeof raw.ownerPid !== 'number' || typeof raw.dataDir !== 'string') continue;
      record = {
        dataDir: raw.dataDir,
        port: typeof raw.port === 'number' ? raw.port : 0,
        pgCtl: typeof raw.pgCtl === 'string' ? raw.pgCtl : null,
        ownerPid: raw.ownerPid,
      };
    } catch {
      continue;
    }
    if (isRunning(record.ownerPid)) continue;
    let outcome: SyncStopOutcome = 'nothing';
    try {
      outcome = stopClusterSync(record, deps);
    } catch {
      outcome = 'nothing';
    }
    reaped.push({ record, outcome });
    try {
      rmSync(path, { force: true });
    } catch {
      /* la fiche resservira au prochain passage */
    }
  }
  return reaped;
}

let reaped = false;

/** Ramasse UNE fois par processus, au premier cluster démarré. */
function reapOnce(): void {
  if (reaped) return;
  reaped = true;
  for (const { record, outcome } of reapAbandonedTestClusters()) {
    process.stderr.write(
      `PG_TEST_CLUSTER_REAPED ownerPid=${record.ownerPid} port=${record.port} ` +
        `outcome=${outcome} dataDir=${record.dataDir}\n`,
    );
  }
}

/** Ce que le registre retient en ce moment. Pour les tests. */
export function registeredTestClusters(): readonly TestClusterEntry[] {
  return [...live];
}

/**
 * Le `pg_ctl` qui accompagne le binaire embarqué, ou `null`.
 *
 * `embedded-postgres` n'exporte que `./dist/index.js`, donc son `binary.js`
 * n'est pas atteignable par spécificateur : il est chargé par CHEMIN, à côté du
 * point d'entrée résolu. Tout est vérifié plutôt que supposé — une disposition
 * qui cesse d'exposer `pg_ctl` rend `null`, et l'arrêt tombe sur le signal.
 */
export async function resolvePgCtlFrom(anchorPackageJson: string): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const { dirname, join: joinPath } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const entry = createRequire(anchorPackageJson).resolve('embedded-postgres');
    const mod = (await import(pathToFileURL(joinPath(dirname(entry), 'binary.js')).href)) as {
      default?: () => Promise<{ pg_ctl?: string }>;
    };
    const binaries = await mod.default?.();
    const pgCtl = binaries?.pg_ctl;
    return pgCtl !== undefined && existsSync(pgCtl) ? pgCtl : null;
  } catch {
    return null;
  }
}
