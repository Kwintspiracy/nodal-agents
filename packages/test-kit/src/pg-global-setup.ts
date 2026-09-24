// pg-global-setup.ts — le `globalSetup` du projet vitest `pg` (#471).
//
// Démarre le serveur Postgres du run et le transmet aux fichiers `.pg` ; voir
// `shared-postgres.ts` pour le pourquoi. Vitest n'appelle ce fichier que si le
// projet `pg` a des fichiers dans le run : une suite sans `.pg` ne paie rien.
//
// S'il ne démarre pas (binaire absent, postmaster refusé), le run ÉCHOUE ici,
// avant tout test : aucun fichier `.pg` ne peut passer pour vert par absence
// (invariant #4).

import type { TestProject } from 'vitest/node';
import { startOwnRealPostgres } from './real-postgres';
import { SHARED_POSTGRES_KEY } from './shared-postgres';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const pg = await startOwnRealPostgres();
  project.provide(SHARED_POSTGRES_KEY, { port: pg.port, dataDir: pg.dataDir });
  return () => pg.stop();
}
