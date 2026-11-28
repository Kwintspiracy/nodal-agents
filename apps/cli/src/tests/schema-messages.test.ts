// schema-messages.test.ts — what the person reads when the schema cannot move
// or must not be opened: each message names the version and the command that
// gets them out.

import { describe, it, expect } from 'vitest';
import { DatabaseNewerThanProgramError } from '@nodal-agents/db/schema-state';
import { SnapshotError } from '@nodal-agents/db/snapshots';
import {
  databaseNewerRefusal,
  migrationFailure,
  snapshotRefusal,
  unclaimedHistoryNotice,
} from '../lib/schema-messages.ts';

describe('schema messages @cap:installer-et-demarrer/moteur', () => {
  it('a newer database names the version that migrated it, and both ways out', () => {
    const err = new DatabaseNewerThanProgramError(
      [1786437400000],
      { version: '0.9.12', lastMigration: '0168_render_pdf_rules', at: '2026-11-28T10:00:00.000Z' },
      '0166_tool_call_read_only_hint',
    );
    const text = databaseNewerRefusal(err, '0.9.11');
    expect(text).toContain(
      'last migrated by Nodal-Agents 0.9.12 (newest migration 0168_render_pdf_rules)',
    );
    expect(text).toContain('this program (0.9.11, newest migration 0166_tool_call_read_only_hint)');
    expect(text).toContain('npm install -g nodal-agents@0.9.12');
    expect(text).toContain('nodal-agents rollback');
    expect(text).toContain('Nothing was changed.');
  });

  it('without a recorded version it says so, and still gives both ways out', () => {
    const text = databaseNewerRefusal(
      new DatabaseNewerThanProgramError([1786437400000], null, '0166_x'),
      '0.9.11',
    );
    expect(text).toContain('not named');
    expect(text).toContain('npm install -g nodal-agents@latest');
    expect(text).toContain('nodal-agents rollback');
  });

  it('a copy that could not be made: not migrated, and why', () => {
    const text = snapshotRefusal(
      new SnapshotError(
        'SNAPSHOT_SOURCE_IN_USE',
        'database "nodalai" cannot be copied while another session is connected to it (pid 42).',
      ),
    );
    expect(text).toContain('The database was NOT migrated');
    expect(text).toContain('pid 42');
  });

  it('a failed migration names the copy and the command that puts it back', () => {
    const text = migrationFailure('division by zero', {
      name: 'nodalai_snap_20261128120000000_0166',
      sizeBytes: 50 * 1024 * 1024,
      meta: null,
      stateDir: '/x',
    });
    expect(text).toContain('division by zero');
    expect(text).toContain('nodalai_snap_20261128120000000_0166 (50.0 MB)');
    expect(text).toContain('nodal-agents rollback nodalai_snap_20261128120000000_0166');
  });
  it('rows no journal claims, older than the journal: one line, how many, their dates, ignored', () => {
    const line = unclaimedHistoryNotice([1785300000000, 1785400000000]);
    expect(line).toContain('2 applied migrations');
    expect(line).toContain(new Date(1785300000000).toISOString());
    expect(line).toContain(new Date(1785400000000).toISOString());
    expect(line).toContain('ignored');
    expect(line.split('\n')).toHaveLength(1);
  });
});
