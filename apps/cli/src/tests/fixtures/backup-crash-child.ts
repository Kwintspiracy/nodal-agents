// backup-crash-child.ts — a backup that stops dead at one step, for
// backup-restore.pg.test.ts to KILL it there and look at what is left on disk.
//
// argv: <database url> <backup folder> <step> <marker file>; NODALAI_HOME names
// the home whose state files go in. At <step> it writes the marker and waits;
// the test kills the process.

import { writeFileSync } from 'node:fs';
import { createBackup, type BackupStep } from '@nodal-agents/db/backup';
import { homeStateFiles } from '@nodal-agents/db/snapshots';

const [url, dir, step, marker] = process.argv.slice(2) as [string, string, BackupStep, string];

await createBackup(url, {
  dir,
  stateFiles: homeStateFiles(),
  programVersion: '9.9.9',
  seams: {
    at: (s) => {
      if (s !== step) return;
      writeFileSync(marker, s);
      // Stopped here until killed.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
    },
  },
});
