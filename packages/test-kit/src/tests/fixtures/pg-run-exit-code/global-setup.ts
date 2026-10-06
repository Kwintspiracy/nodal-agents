import { loadEmbeddedPostgres } from '../../../real-postgres';

export default async function setup(): Promise<void> {
  await loadEmbeddedPostgres();
  // La garde vérifie cette ligne : sans elle, un run qui n'aurait rien chargé
  // passerait la garde sans jamais avoir rencontré le crochet de sortie.
  process.stdout.write('EMBEDDED_POSTGRES_LOADED\n');
}
