// migration-pack-filter.test.mjs — which migration files ship in the pack.
//
// The published tarball carried drizzle-kit's schema snapshots: 12 files,
// 1.3 MB — five times the weight of all 87 migrations combined (274 kB) — for
// something the migrator never opens. Verified against drizzle-orm 0.45.2's
// migrator.cjs, which reads one file out of meta/:
//
//     const journalPath = `${migrationFolderTo}/meta/_journal.json`;
//
// Run from the repo root: npx vitest run scripts/tests/migration-pack-filter.test.mjs

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldPackMigrationFile } from '../lib/migration-pack-filter.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = resolve(repoRoot, 'packages/db/migrations');

describe('shouldPackMigrationFile', () => {
  it('ships every .sql migration', () => {
    expect(shouldPackMigrationFile('0000_flashy_clea.sql')).toBe(true);
    expect(shouldPackMigrationFile('0087_workspaces_hidden_from_code.sql')).toBe(true);
  });

  it('ships the journal — the ONE file the migrator opens', () => {
    expect(shouldPackMigrationFile('meta/_journal.json')).toBe(true);
  });

  it('drops the drizzle-kit snapshots', () => {
    expect(shouldPackMigrationFile('meta/0000_snapshot.json')).toBe(false);
    expect(shouldPackMigrationFile('meta/0010_snapshot.json')).toBe(false);
  });

  it('handles Windows separators — the pack is built there too', () => {
    expect(shouldPackMigrationFile('meta\\0000_snapshot.json')).toBe(false);
    expect(shouldPackMigrationFile('meta\\_journal.json')).toBe(true);
  });

  it('ships an unknown new file rather than dropping it silently', () => {
    // Allow-by-default: the boot sequence depends on this folder, so a file
    // nobody anticipated must travel rather than vanish.
    expect(shouldPackMigrationFile('meta/something-new.json')).toBe(true);
    expect(shouldPackMigrationFile('README.md')).toBe(true);
  });
});

describe('against the REAL migrations folder', () => {
  // A unit test on a pure function proves the rule; this proves the rule still
  // matches the repository it is applied to. A snapshot naming convention that
  // changes upstream would otherwise pass the tests above and quietly start
  // shipping 1.3 MB again.
  const entries = existsSync(migrationsDir)
    ? readdirSync(migrationsDir, { recursive: true, encoding: 'utf-8' })
    : [];

  it('finds the folder', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('keeps every .sql file that exists today', () => {
    const sql = entries.filter((e) => e.endsWith('.sql'));
    expect(sql.length).toBeGreaterThan(80);
    expect(sql.every((e) => shouldPackMigrationFile(e))).toBe(true);
  });

  it('keeps the real journal', () => {
    const journal = entries.filter((e) => e.replace(/\\/g, '/').endsWith('meta/_journal.json'));
    expect(journal).toHaveLength(1);
    expect(shouldPackMigrationFile(journal[0])).toBe(true);
  });

  it('drops every snapshot that exists today, and there are some to drop', () => {
    const snapshots = entries.filter((e) => /\d+_snapshot\.json$/.test(e));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((e) => shouldPackMigrationFile(e))).toBe(false);
  });
});
