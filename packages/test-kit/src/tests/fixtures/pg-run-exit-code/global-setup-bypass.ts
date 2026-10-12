// Le contournement DÉLIBÉRÉ : le paquet est chargé une première fois sans la
// porte (résolution + `import()` calculé, la forme que la PR #699 a retirée de
// real-postgres.ts), PUIS par la porte. La garde prouve que la porte retire le
// crochet même quand quelqu'un l'a posé avant elle. Seul fichier, avec la
// porte et le test d'architecture du CLI, autorisé à nommer le paquet.
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadEmbeddedPostgres } from '../../../real-postgres';

export default async function setup(): Promise<void> {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
  );
  const entry = createRequire(join(repoRoot, 'apps', 'cli', 'package.json')).resolve(
    'embedded-postgres',
  );
  const before = process.listenerCount('beforeExit');
  await import(pathToFileURL(entry).href);
  // Sans crochet posé par ce chargement direct, la garde ne prouverait rien.
  if (process.listenerCount('beforeExit') <= before) {
    throw new Error('BYPASS_DID_NOT_HOOK: le chargement direct n’a posé aucun beforeExit');
  }
  process.stdout.write('EMBEDDED_POSTGRES_LOADED_BEFORE_THE_DOOR\n');
  await loadEmbeddedPostgres();
  process.stdout.write('EMBEDDED_POSTGRES_LOADED\n');
}
