// schema-state.test.ts — where a schema stands against a journal, without a
// database: pending, skipped, and migrations this program does not know.

import { describe, it, expect } from 'vitest';
import { schemaStateOf } from '../schema-state.ts';

const journal = [
  { idx: 0, when: 1000, tag: '0000_a' },
  { idx: 1, when: 2000, tag: '0001_b' },
  { idx: 2, when: 3000, tag: '0002_c' },
  { idx: 3, when: 4000, tag: '0003_d' },
];

describe('schemaStateOf @cap:installer-et-demarrer/moteur', () => {
  it('a database nothing migrated: every entry pending, nothing unknown', () => {
    const s = schemaStateOf(journal, null);
    expect(s.pending.map((e) => e.tag)).toEqual(['0000_a', '0001_b', '0002_c', '0003_d']);
    expect(s.gaps).toEqual([]);
    expect(s.unknown).toEqual([]);
    expect(s.lastApplied).toBeNull();
  });

  it('pending = the entries after the newest applied, which is what the migrator applies', () => {
    const s = schemaStateOf(journal, [1000, 2000]);
    expect(s.pending.map((e) => e.tag)).toEqual(['0002_c', '0003_d']);
    expect(s.lastApplied).toEqual({ when: 2000, tag: '0001_b' });
    expect(s.gaps).toEqual([]);
  });

  it('a skipped entry below the newest applied is a gap, not a pending one', () => {
    const s = schemaStateOf(journal, [1000, 3000]);
    expect(s.gaps).toEqual([{ idx: 1, tag: '0001_b', when: 2000 }]);
    expect(s.pending.map((e) => e.tag)).toEqual(['0003_d']);
  });

  it('a history row this journal does not have: unknown, the database is newer', () => {
    // An older program: its journal stops at 0001; the database went to 0003.
    const older = journal.slice(0, 2);
    const s = schemaStateOf(older, [1000, 2000, 3000, 4000]);
    expect(s.unknown).toEqual([3000, 4000]);
    expect(s.pending).toEqual([]);
    expect(s.lastApplied).toEqual({ when: 4000, tag: null });
  });

  it('an unknown row BETWEEN known ones (a renumbered migration) is unknown too', () => {
    const s = schemaStateOf(journal, [1000, 1500, 2000]);
    expect(s.unknown).toEqual([1500]);
  });
});
