// Reproduce the EXACT CLI code path
import { startEmbeddedPostgres } from './src/lib/postgres.ts';

console.log('Calling startEmbeddedPostgres via the CLI helper...');
try {
  const pg = await startEmbeddedPostgres(undefined, 15432);
  console.log('OK, vectorAvailable=', pg.vectorAvailable);
  await pg.stop();
  console.log('Stopped OK');
} catch (e) {
  console.log('FAILED type:', typeof e);
  console.log('  String(e):', String(e));
  console.log('  e.message:', e?.message);
  console.log('  e.stack:', e?.stack);
}
