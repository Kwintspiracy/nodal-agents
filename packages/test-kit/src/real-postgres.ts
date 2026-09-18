// real-postgres.ts — un VRAI Postgres pour les tests de course.
//
// Tout le dépôt teste sur PGlite en mémoire, mono-connexion : deux
// transactions « concurrentes » y sont sérialisées, si bien qu'aucun test
// existant ne prouve qu'un `FOR UPDATE` verrouille quoi que ce soit — le
// commentaire d'execute-ready.ts qui l'affirme est faux (sonde du 03/09). Le
// plan « Vérifier & Corriger » repose sur des verrous et des claims
// atomiques ; ils se prouvent à DEUX connexions réelles ou pas du tout.
//
// Le binaire : `embedded-postgres` n'est une dépendance que d'apps/cli (c'est
// le Postgres embarqué de `nodal-agents up`). `pnpm install` étant cassé sur
// cette machine (Node 26.4.0) et un package.json de plus n'étant pas la bonne
// réponse à un besoin de test, on le résout DEPUIS apps/cli par
// `createRequire` — reproductible en CI, où apps/cli/node_modules existe après
// l'install, et dit tel quel ici plutôt que caché derrière une jonction.
//
// Invariant #4 : ce harnais ÉCHOUE quand le binaire manque. Un test qui se
// saute est un test vert par absence.

import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { withPostgresClusterStart } from './cluster-lock';
import {
  registerTestCluster,
  resolvePgCtlFrom,
  unregisterTestCluster,
  type TestClusterEntry,
} from './cluster-registry';

export interface RealPostgres {
  /** `postgresql://user:pwd@localhost:port/db` — même forme que le CLI. */
  url: string;
  port: number;
  dataDir: string;
  /** Arrête le postmaster et supprime le data dir. Idempotent. */
  stop: () => Promise<void>;
}

/** La surface d'embedded-postgres que ce harnais utilise — typée ici, sans dépendre du paquet. */
interface EmbeddedPostgresLike {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
}
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  createPostgresUser?: boolean;
  initdbFlags?: string[];
  onError?: (e: unknown) => void;
  onLog?: (m: string) => void;
}) => EmbeddedPostgresLike;

const PG_USER = 'nodalai';
const PG_PASSWORD = 'test';
const PG_DATABASE = 'nodalai_test';

/** Racine du monorepo, dérivée de ce fichier (packages/test-kit/src/…). */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Résout `embedded-postgres` comme apps/cli le voit. Lève avec le chemin
 * cherché quand il manque — c'est l'information dont on a besoin pour réparer.
 */
async function loadEmbeddedPostgres(): Promise<{ ctor: EmbeddedPostgresCtor; resolved: string }> {
  const anchor = join(repoRoot(), 'apps', 'cli', 'package.json');
  let resolved: string;
  try {
    resolved = createRequire(anchor).resolve('embedded-postgres');
  } catch (err) {
    throw new Error(
      `REAL_POSTGRES_UNAVAILABLE: embedded-postgres introuvable depuis ${anchor} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as { default: EmbeddedPostgresCtor };
  if (typeof mod.default !== 'function') {
    throw new Error(`REAL_POSTGRES_UNAVAILABLE: export par défaut inattendu dans ${resolved}`);
  }
  // Le paquet natif de la plateforme est un dépendant OPTIONNEL
  // (`@embedded-postgres/<os>-<arch>`) : présent dans le lockfile mais absent
  // de l'install, `initdb` n'existe pas et le démarrage rejette sans message.
  // On le dit ICI, avec le chemin cherché, plutôt qu'au premier spawn muet.
  const binDir = join(dirname(resolved), '..', '..', `@embedded-postgres`);
  return { ctor: mod.default, resolved: `${resolved} (natifs attendus sous ${binDir})` };
}

/** Un port libre, choisi par le système (bind sur 0), puis relâché. */
function pickAnyFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? res(port) : rej(new Error('REAL_POSTGRES_NO_PORT'))));
    });
  });
}

/**
 * Les ports que l'INSTALLATION locale utilise, lus dans `~/.nodalai/config.json`.
 *
 * Un cluster de test ne doit jamais en prendre un (issue #130) : un survivant
 * assis sur le port Postgres du poste de travail est un ÉTRANGER pour
 * `nodal-agents up` — sa preuve de propriété passe par le data dir de
 * l'installation, pas par le port — et `up` refuse alors de démarrer, comme il
 * doit. La réparation n'est donc PAS d'apprendre à `up` à reconnaître un
 * cluster de test : le module `orphans.ts` d'apps/cli existe précisément parce
 * qu'une table de processus ne peut pas dire à qui appartient un cluster, et
 * cette leçon a coûté une base de données vivante le 14/09. Elle est de rendre
 * la collision IMPOSSIBLE.
 *
 * Aucun secret n'est lu ici : seulement les trois numéros de port. Une
 * configuration absente ou illisible rend la liste vide — il n'y a alors pas
 * d'installation à protéger.
 */
export function installedPorts(
  configPath: string = join(homedir(), '.nodalai', 'config.json'),
): number[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    const ports = (cfg as { ports?: unknown })?.ports;
    if (ports === null || typeof ports !== 'object') return [];
    return Object.values(ports as Record<string, unknown>).filter(
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Un port libre qui n'est AUCUN de ceux qu'on refuse.
 *
 * Le système choisit dans la plage éphémère, très au-dessus des ports du
 * produit, donc la collision est déjà improbable ; « improbable » n'est pas
 * « impossible », et le coût de la certitude est cette boucle. Dix essais, puis
 * un échec nommé plutôt qu'un port qu'on n'a pas le droit de prendre.
 */
export async function pickFreePort(
  avoid: readonly number[] = [],
  // Injectable pour que le REFUS soit éprouvable : on ne choisit pas ce que le
  // système attribue, donc un test qui se contenterait d'appeler la vraie
  // source ne verrait jamais le cas qu'on veut prouver.
  source: () => Promise<number> = pickAnyFreePort,
): Promise<number> {
  const taken = new Set(avoid);
  const refused: number[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await source();
    if (!taken.has(port)) return port;
    refused.push(port);
  }
  throw new Error(
    `REAL_POSTGRES_NO_PORT: dix ports libres étaient tous réservés à l'installation (${refused.join(', ')})`,
  );
}

/**
 * Démarre un Postgres embarqué neuf sur un data dir temporaire et un port
 * libre. Aucune migration n'est appliquée ici : l'appelant fait tourner les
 * VRAIES migrations via `runMigrations` de @nodal-agents/db (ce harnais ne
 * dépend pas de db — db en dépend en dev, un cycle serait de trop).
 */
export function startRealPostgres(): Promise<RealPostgres> {
  // SOUS LE VERROU DE LA MACHINE (issue #130). `pnpm test` lance un `vitest run`
  // par paquet, en même temps : sérialiser ici est la seule façon d'empêcher
  // cinq `initdb` simultanés, qu'aucun réglage vitest ne voit. Le verrou couvre
  // les trois essais — ils sont UN démarrage — et il est rendu dès que le
  // cluster répond, jamais gardé pendant la suite qui s'en sert.
  return withPostgresClusterStart('real-postgres', startRealPostgresLocked);
}

async function startRealPostgresLocked(): Promise<RealPostgres> {
  const { ctor: EmbeddedPostgres, resolved: binaryPath } = await loadEmbeddedPostgres();
  const attempts: string[] = [];
  // Résolu UNE fois, avant tout démarrage : le gestionnaire de sortie qui
  // arrête les clusters survivants est synchrone et ne peut pas faire cet
  // `import()`. Null quand il échoue — l'arrêt tombe alors sur le signal.
  const pgCtl = await resolvePgCtlFrom(join(repoRoot(), 'apps', 'cli', 'package.json'));
  const reserved = installedPorts();

  // TROIS ESSAIS, chacun sur un port neuf.
  //
  // `pickFreePort` bind 0, lit le port attribué, PUIS le relâche : entre ce
  // relâchement et le `listen` du postmaster, le système peut donner le même
  // port à quelqu'un d'autre — et trois suites `.pg.test.ts` démarrent en
  // parallèle dans ce paquet, ce qui rend la collision plausible plutôt que
  // théorique. C'est l'hypothèse la plus probable pour l'échec observé sur le
  // runner GitHub Windows (PR #46), où les trois suites ont lâché en même
  // temps. Elle n'est pas PROUVÉE : c'est pourquoi l'erreur finale rapporte
  // chaque essai, son étape et les logs du postmaster — un prochain rouge
  // tranchera sans avoir à re-instrumenter.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dataDir = await mkdtemp(join(tmpdir(), 'nodal-pg-'));
    const port = await pickFreePort(reserved);
    const logs: string[] = [];
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: PG_USER,
      password: PG_PASSWORD,
      port,
      persistent: false,
      createPostgresUser: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onError: (e) => logs.push(`ERROR ${e instanceof Error ? e.message : String(e)}`),
      onLog: (m) => logs.push(m),
    });
    // L'ÉTAPE est nommée : `embedded-postgres` rejette parfois avec
    // `undefined`, et « START_FAILED: undefined » n'aide personne. On dit donc
    // où ça a lâché, et ce que le postmaster a écrit — TOUS les logs, pas
    // seulement ceux qui portent FATAL, puisque justement il n'y en avait
    // aucun.
    let step: 'initialise' | 'start' | 'createDatabase' = 'initialise';
    try {
      await pg.initialise();
      step = 'start';
      await pg.start();
      step = 'createDatabase';
      await pg.createDatabase(PG_DATABASE);
      // Inscrit AVANT d'être rendu : entre ce point et le `stop()` de
      // l'appelant, un Ctrl+C doit trouver ce cluster dans le registre.
      const entry = registerTestCluster({ dataDir, port, pgCtl });
      return makeHandle(pg, dataDir, port, entry);
    } catch (err) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      const detail =
        err instanceof Error
          ? err.message
          : err === undefined
            ? '(rejet sans valeur)'
            : String(err);
      const tail = logs.slice(-25);
      attempts.push(
        `essai ${attempt} — étape ${step}, port ${port} : ${detail}` +
          (tail.length ? `\n      ${tail.join('\n      ')}` : ' (aucun log du postmaster)'),
      );
    }
  }

  throw new Error(
    `REAL_POSTGRES_START_FAILED après 3 essais (binaire ${binaryPath}) :\n  ${attempts.join('\n  ')}`,
  );
}

/** La poignée rendue à l'appelant : l'arrêt du postmaster et le ménage. */
/**
 * Une erreur de MÉNAGE, pas de test : le système refuse de supprimer un
 * fichier encore ouvert. Tout le reste (un postmaster qui refuse de s'arrêter,
 * par exemple) doit continuer de remonter.
 */
function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES';
}

function makeHandle(
  pg: EmbeddedPostgresLike,
  dataDir: string,
  port: number,
  entry: TestClusterEntry,
): RealPostgres {
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Retiré du registre d'entrée de jeu : ce cluster a désormais quelqu'un
    // pour l'arrêter, et un gestionnaire de sortie qui se déclencherait pendant
    // ce `stop()` ne doit pas signaler un postmaster déjà en train de s'arrêter.
    unregisterTestCluster(entry);
    try {
      // `persistent: false` fait supprimer le dossier de données PAR la
      // bibliothèque, à l'arrêt. Sous Windows et sous charge, le postmaster
      // garde ses fichiers ouverts quelques instants de plus, et ce ménage
      // lève `EBUSY` — une suite entière tombait alors, alors que TOUTES ses
      // assertions étaient passées (vu le 07/09 : les trois suites `.pg` en
      // échec dans la suite complète, vertes une par une). Un dossier
      // temporaire qui résiste n'est pas un résultat de test : le système
      // nettoie son propre `%TEMP%`, et la boucle ci-dessous réessaie.
      await pg.stop();
    } catch (err) {
      if (!isBusyError(err)) throw err;
    } finally {
      // Windows garde parfois un handle quelques centaines de ms après
      // l'arrêt — sous charge, bien plus : on réessaie jusqu'à ~6 s, puis on
      // abandonne EN SILENCE.
      for (let i = 0; i < 12; i++) {
        try {
          await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  };
  return {
    url: `postgresql://${PG_USER}:${encodeURIComponent(PG_PASSWORD)}@localhost:${port}/${PG_DATABASE}`,
    port,
    dataDir,
    stop,
  };
}
