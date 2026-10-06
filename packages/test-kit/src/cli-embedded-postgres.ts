// cli-embedded-postgres.ts — le harnais charge `embedded-postgres` par la porte
// d'apps/cli, et par aucune autre (issue #698).
//
// Le paquet n'est une dépendance que d'apps/cli (c'est le Postgres embarqué de
// `nodal-agents up`), et `apps/cli/src/lib/embedded-postgres-module.ts` est le
// seul fichier du dépôt qui le nomme : il retire, à chaque chargement, le
// `beforeExit` qui finit le processus par `process.exit(0)`. Un chargement par
// un autre chemin rendait 0 à tout run vitest rouge contenant un `.pg`.
//
// Le module est importé par CHEMIN, calculé depuis ce fichier : test-kit ne
// dépend d'aucun paquet du workspace (il est la devDependency de tous), et un
// `package.json` de plus n'est pas la bonne réponse à un besoin de test.

import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** La surface du module d'apps/cli que le harnais utilise — typée ici, sans dépendre d'apps/cli. */
export interface CliEmbeddedPostgres {
  resolveEmbeddedPostgresEntry(): string;
  importEmbeddedPostgres(): Promise<unknown>;
  importEmbeddedPostgresBinaries(): Promise<Record<string, unknown> | undefined>;
}

/** Le chemin du module, exporté pour les messages d'erreur. */
export const CLI_EMBEDDED_POSTGRES_MODULE: string = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'apps',
  'cli',
  'src',
  'lib',
  'embedded-postgres-module.ts',
);

export async function cliEmbeddedPostgres(): Promise<CliEmbeddedPostgres> {
  const mod = (await import(pathToFileURL(CLI_EMBEDDED_POSTGRES_MODULE).href)) as Partial<
    Record<keyof CliEmbeddedPostgres, unknown>
  >;
  for (const name of [
    'resolveEmbeddedPostgresEntry',
    'importEmbeddedPostgres',
    'importEmbeddedPostgresBinaries',
  ] as const) {
    if (typeof mod[name] !== 'function') {
      throw new Error(
        `REAL_POSTGRES_UNAVAILABLE: ${name} absent de ${CLI_EMBEDDED_POSTGRES_MODULE}`,
      );
    }
  }
  return mod as CliEmbeddedPostgres;
}
