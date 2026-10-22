// detached-launcher.fixture.ts — a stand-in for the tail of `nodal-agents up`.
//
// It starts the embedded cluster the way `up` does (`startEmbeddedPostgres`),
// says READY, then ends the way `up` ends: `--detach` releases the cluster from
// the package's stop-at-exit and calls `process.exit(0)`; a foreground launcher
// just exits. The test runs it as a child process and looks at what is left of
// the cluster once this process is gone.
//
//   node --import tsx detached-launcher.fixture.ts <dataDir> <port> <detached|foreground>

import { readPostmasterPid, startEmbeddedPostgres } from '../../lib/postgres.ts';

const [dataDir, port, mode] = process.argv.slice(2);
if (dataDir === undefined || port === undefined || (mode !== 'detached' && mode !== 'foreground')) {
  console.error('usage: <dataDir> <port> <detached|foreground>');
  process.exit(2);
}

const detached = mode === 'detached';
const pg = await startEmbeddedPostgres(
  dataDir,
  Number(port),
  'detached-launcher-password-0123456789',
  `${dataDir}-logs`,
  { detached },
);
console.log(`READY pid=${readPostmasterPid(dataDir)}`);
if (detached) pg.outliveLauncher();
process.exit(0);
