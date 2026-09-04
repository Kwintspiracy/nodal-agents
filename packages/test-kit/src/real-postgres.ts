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
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

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
async function loadEmbeddedPostgres(): Promise<EmbeddedPostgresCtor> {
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
  return mod.default;
}

/** Un port libre, choisi par le système (bind sur 0), puis relâché. */
export function pickFreePort(): Promise<number> {
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
 * Démarre un Postgres embarqué neuf sur un data dir temporaire et un port
 * libre. Aucune migration n'est appliquée ici : l'appelant fait tourner les
 * VRAIES migrations via `runMigrations` de @nodal-agents/db (ce harnais ne
 * dépend pas de db — db en dépend en dev, un cycle serait de trop).
 */
export async function startRealPostgres(): Promise<RealPostgres> {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const dataDir = await mkdtemp(join(tmpdir(), 'nodal-pg-'));
  const port = await pickFreePort();
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
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(PG_DATABASE);
  } catch (err) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    const fatal = logs.filter((l) => /\b(FATAL|PANIC|ERROR)\b/.test(l)).slice(-10);
    throw new Error(
      `REAL_POSTGRES_START_FAILED: ${err instanceof Error ? err.message : String(err)}` +
        (fatal.length ? `\n  ${fatal.join('\n  ')}` : ''),
    );
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await pg.stop();
    } finally {
      // Windows garde parfois un handle quelques centaines de ms après l'arrêt.
      for (let i = 0; i < 5; i++) {
        try {
          await rm(dataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
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
