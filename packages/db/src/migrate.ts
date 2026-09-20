// migrate.ts — run Drizzle migrations against a connection string
// Only @nodal-agents/db may import drizzle-orm directly (architecture rule).

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export interface RunMigrationsOptions {
  /**
   * If true, rewrite `vector(N)` column types to `text` before applying the
   * migrations. Used when pgvector extension isn't available — semantic
   * memory search falls back to keyword mode (handled in @nodal-agents/memory).
   * Default: false.
   */
  patchVectorAsText?: boolean;
}

/**
 * Apply all pending Drizzle migrations to the given database.
 * Uses the migration files bundled with @nodal-agents/db at packages/db/migrations/.
 */
export async function runMigrations(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  // postgres.js prints every server NOTICE to the console when no handler is
  // set, and Drizzle's own bootstrap raises two on any database that already
  // has migrations: `schema "drizzle" already exists` and `relation
  // "__drizzle_migrations" already exists`. Both are the CREATE ... IF NOT
  // EXISTS working as intended — but they arrive as multi-line objects with a
  // `file`/`line`/`routine` trailer, so an upgrade looks like it just crashed.
  // Observed 2026-08-21 during the 0.8.1 → 0.8.5 upgrade smoke.
  //
  // NOTICE is dropped; anything more severe still goes through, so a real
  // warning from the server is never hidden (invariant #4). Failures were never
  // routed here at all — they reject, and `up` stops on them.
  const sql = postgres(connectionString, {
    max: 1,
    onnotice: (notice) => {
      if (notice.severity === 'NOTICE') return;
      console.warn(`[db] ${notice.severity}: ${notice.message}`);
    },
  });
  const db = drizzle(sql);

  const migrationsFolder = effectiveMigrationsFolder(opts);

  await migrate(db, { migrationsFolder });
  await sql.end();
}

/**
 * Where the migrations live, for the layout this build is running in.
 *
 * Two layouts to support:
 *   - Monorepo dev: this file lives at packages/db/src/migrate.ts, so
 *     migrations are one level up at packages/db/migrations/.
 *   - Bundled pack: this code is inlined into runner.js / cli.js at the pack
 *     root, and migrations are copied to pack/migrations/ as a sibling.
 * Probe sibling first (cheaper, more common in shipped artifacts), then fall
 * back to the dev layout.
 */
function sourceMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'migrations');
  return existsSync(sibling) ? sibling : join(here, '../migrations');
}

/** The folder Drizzle is actually pointed at — patched when pgvector is absent. */
function effectiveMigrationsFolder(opts: RunMigrationsOptions): string {
  const source = sourceMigrationsFolder();
  return opts.patchVectorAsText ? patchMigrationsForNoVector(source) : source;
}

/**
 * Copy the migrations folder to a tmp dir and rewrite any `vector(N)` column
 * type to `text`. Returns the path to the patched folder. Drizzle's migrator
 * needs the meta/ subfolder + journal file too — we copy those verbatim so the
 * migration tracking works.
 */
function patchMigrationsForNoVector(sourceFolder: string): string {
  const tmpFolder = mkdtempSync(join(tmpdir(), 'nodalai-migrations-'));
  const metaDir = join(tmpFolder, 'meta');
  mkdirSync(metaDir, { recursive: true });

  for (const entry of readdirSync(sourceFolder, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'meta') {
      for (const metaFile of readdirSync(join(sourceFolder, 'meta'))) {
        const content = readFileSync(join(sourceFolder, 'meta', metaFile), 'utf8');
        writeFileSync(join(metaDir, metaFile), content);
      }
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      const content = readFileSync(join(sourceFolder, entry.name), 'utf8');
      // Replace `vector(NNN)` with `text` — preserves column declarations
      // without requiring the pgvector extension.
      const patched = content.replace(/\bvector\(\d+\)/g, 'text');
      writeFileSync(join(tmpFolder, entry.name), patched);
    }
  }

  return tmpFolder;
}

// ─── Les trous du journal (issue #298) ───────────────────────────────────────
//
// ⚠️ LE MIGRATEUR DE DRIZZLE SAUTE EN SILENCE UNE MIGRATION MERGÉE APRÈS UNE
// PLUS RÉCENTE. Sa boucle (drizzle-orm/pg-core/dialect, `migrate`) ne garde
// que la DERNIÈRE ligne d'historique et n'applique une entrée que si son
// `when` dépasse ce `created_at` :
//
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
//
// Une entrée dont le `when` est INFÉRIEUR au dernier appliqué est donc passée,
// définitivement, sans un mot. C'est arrivé le 20/09/2026 sur la base du
// propriétaire : 0114 a atteint `main` après qu'un redémarrage eut appliqué
// 0115, et toute écriture dans `code_projects` a échoué ensuite sur une
// colonne absente, sans que rien au démarrage ne le dise.
//
// ⚠️ ON COMPARE PAR `when`, JAMAIS PAR HASH. Le hash enregistré est celui du
// FICHIER APPLIQUÉ : quand `patchVectorAsText` réécrit `vector(N)` en `text`,
// c'est le hash du fichier PATCHÉ qui part en base, et il ne correspond alors
// à aucun fichier du dépôt. Un contrôle par hash signalerait des trous
// imaginaires sur toute installation sans pgvector. Le `when`, lui, est écrit
// tel quel dans `created_at` par drizzle, patché ou non.

/** Une entrée de `meta/_journal.json`. */
interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

/** Une migration que le journal annonce et que la base n'a jamais appliquée. */
export interface MigrationGap {
  idx: number;
  tag: string;
  /** L'horodatage du journal — ce que drizzle écrit dans `created_at`. */
  when: number;
}

/**
 * Les entrées du journal qu'aucune ligne d'historique ne réclame.
 *
 * PURE, et c'est voulu : la règle se teste sans base, avec un journal de
 * quatre et un historique de trois.
 */
export function gapsBetween(
  journal: readonly { idx: number; when: number; tag: string }[],
  horodatagesAppliques: readonly number[],
): MigrationGap[] {
  const applique = new Set(horodatagesAppliques.map((w) => Number(w)));
  return journal
    .filter((e) => !applique.has(Number(e.when)))
    .map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }));
}

/** Le journal du dossier de migrations, dans son ordre. */
function readJournal(folder: string): JournalEntry[] {
  const chemin = join(folder, 'meta', '_journal.json');
  if (!existsSync(chemin)) {
    // Invariant #4 : sans journal, drizzle-kit ignore TOUT en silence. On ne
    // rend pas « aucun trou » sur une absence — on le dit.
    throw new Error(`migration journal not found at ${chemin}`);
  }
  const brut = JSON.parse(readFileSync(chemin, 'utf8')) as { entries?: JournalEntry[] };
  return brut.entries ?? [];
}

/** Les `created_at` déjà enregistrés, ou `null` quand la table n'existe pas. */
async function appliedWhen(sql: postgres.Sql): Promise<number[] | null> {
  const [present] = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`;
  if (present?.ok !== true) return null;
  const lignes = await sql<{ created_at: string | number | null }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations`;
  return lignes.map((l) => Number(l.created_at)).filter((n) => Number.isFinite(n));
}

/**
 * Les migrations que le journal annonce et que cette base n'a jamais reçues.
 *
 * À appeler APRÈS `runMigrations` : c'est l'état d'après qui compte, et la
 * table d'historique existe alors forcément. Une base sans table d'historique
 * n'a rien appliqué du tout — ce n'est pas une base à trous, c'est une base
 * que personne n'a migrée, et on rend une liste vide plutôt que 117 trous.
 */
export async function findMigrationGaps(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<MigrationGap[]> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const applique = await appliedWhen(sql);
    if (applique === null) return [];
    return gapsBetween(readJournal(effectiveMigrationsFolder(opts)), applique);
  } finally {
    await sql.end();
  }
}

/**
 * Applique les migrations manquantes, DANS L'ORDRE DU JOURNAL, et les
 * enregistre comme drizzle l'aurait fait.
 *
 * Le format de la ligne est celui de drizzle, vérifié dans son code et contre
 * une vraie base : `hash` = sha256 du CONTENU ENTIER du fichier appliqué,
 * `created_at` = le `when` du journal. Les instructions sont découpées sur
 * `--> statement-breakpoint`, comme le fait `readMigrationFiles`.
 *
 * Chaque migration est sa propre transaction : une qui échoue laisse les
 * précédentes en place et n'enregistre pas la sienne, donc une seconde
 * réparation reprend exactement là où celle-ci s'est arrêtée.
 *
 * Rend ce qui a été appliqué, dans l'ordre.
 */
export async function repairMigrations(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<MigrationGap[]> {
  const folder = effectiveMigrationsFolder(opts);
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const applique = await appliedWhen(sql);
    if (applique === null) return [];
    const trous = gapsBetween(readJournal(folder), applique);
    for (const trou of trous) {
      const fichier = join(folder, `${trou.tag}.sql`);
      if (!existsSync(fichier)) {
        // Invariant #4 : un journal qui nomme un fichier absent est une faute
        // de dépôt, pas un cas d'exécution. On s'arrête dessus.
        throw new Error(`migration file missing for journal entry ${trou.tag}: ${fichier}`);
      }
      const contenu = readFileSync(fichier, 'utf8');
      const hash = createHash('sha256').update(contenu).digest('hex');
      await sql.begin(async (tx) => {
        for (const instruction of contenu.split('--> statement-breakpoint')) {
          if (instruction.trim() === '') continue;
          await tx.unsafe(instruction).simple();
        }
        await tx`INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
                 VALUES (${hash}, ${trou.when})`;
      });
    }
    return trous;
  } finally {
    await sql.end();
  }
}
