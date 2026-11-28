// migration-order.test.mjs — the CI guard of #1120: a journal every published
// install can still apply.
//
// Run from the repo root: npx vitest run scripts/tests/migration-order.test.mjs

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationOrderViolations, newestReleaseTag } from '../lib/migration-order.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOURNAL = 'packages/db/migrations/meta/_journal.json';

const e = (idx, when, tag) => ({ idx, when, tag });
const release = {
  tag: 'v0.9.10',
  entries: [
    e(163, 1786436900000, '0163_a'),
    e(164, 1786437000000, '0164_b'),
    e(166, 1786437200000, '0166_c'),
  ],
};

describe('migrationOrderViolations @cap:installer-et-demarrer/moteur', () => {
  it('accepts a journal whose new entries all come after the release', () => {
    expect(
      migrationOrderViolations(release, [...release.entries, e(167, 1786437300000, '0167_d')]),
    ).toEqual([]);
  });

  it('refuses the #1120 case: an entry reserved before the release, merged after it', () => {
    // 0165 was reserved with a `when` between 0164 and 0166; 0.9.10 shipped 0166.
    const v = migrationOrderViolations(release, [
      ...release.entries,
      e(165, 1786437100000, '0165_late'),
    ]);
    expect(v).toEqual([
      expect.objectContaining({
        tag: '0165_late',
        rule: 'not-after-release',
        when: 1786437100000,
        mustExceed: 1786437200000,
      }),
    ]);
    // It names the entry and the value to exceed, so the fix is obvious.
    expect(v[0].message).toContain('0165_late');
    expect(v[0].message).toContain('greater than 1786437200000');
  });

  it('refuses a new entry whose `when` EQUALS the newest released one', () => {
    const v = migrationOrderViolations(release, [
      ...release.entries,
      e(167, 1786437200000, '0167_same'),
    ]);
    expect(v.map((x) => x.rule)).toEqual(['not-after-release']);
  });

  it('refuses a released entry whose `when` changed, or that was removed', () => {
    const changed = release.entries.map((x) =>
      x.tag === '0164_b' ? { ...x, when: 1786437250000 } : x,
    );
    expect(migrationOrderViolations(release, changed)).toEqual([
      expect.objectContaining({
        tag: '0164_b',
        rule: 'released-entry-changed',
        released: 1786437000000,
      }),
    ]);
    const removed = release.entries.filter((x) => x.tag !== '0163_a');
    expect(migrationOrderViolations(release, removed)).toEqual([
      expect.objectContaining({ tag: '0163_a', rule: 'released-entry-removed' }),
    ]);
  });
});

describe('newestReleaseTag: the code base’s version rule', () => {
  it('orders numerically and puts a release after its pre-release', () => {
    expect(newestReleaseTag('v0.9.9\nv0.9.10\nv0.9.8\n')).toBe('v0.9.10');
    expect(newestReleaseTag('v1.0.0-rc.2\nv1.0.0-rc.10\n')).toBe('v1.0.0-rc.10');
    expect(newestReleaseTag('v1.0.0-rc.10\nv1.0.0\n')).toBe('v1.0.0');
    expect(newestReleaseTag('vNext\nlatest\n')).toBeNull();
    expect(newestReleaseTag('')).toBeNull();
  });
});

describe('the real journal against the newest release tag', () => {
  it('holds: every released entry unchanged, every new one after them', () => {
    const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf-8' });
    const tag = newestReleaseTag(tags);
    // No tag means the checkout did not fetch them: that proves nothing, and
    // the test says so instead of passing (CI fetches them before this job's
    // script tests, see .github/workflows/ci.yml).
    expect(
      tag,
      'no v* tag in this checkout: git fetch --no-tags origin "+refs/tags/v*:refs/tags/v*"',
    ).not.toBeNull();
    const released = JSON.parse(
      execFileSync('git', ['show', `${tag}:${JOURNAL}`], { cwd: repoRoot, encoding: 'utf-8' }),
    ).entries;
    const current = JSON.parse(readFileSync(resolve(repoRoot, JOURNAL), 'utf-8')).entries;
    expect(migrationOrderViolations({ tag, entries: released }, current)).toEqual([]);
  });
});
