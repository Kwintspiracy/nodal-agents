#!/usr/bin/env node
// check-migration-order.mjs — refuse a migration journal that published
// installs would apply only in part (#1120). The rule: scripts/lib/migration-order.mjs.
//
// The reference is the journal at the newest `v*` tag. In CI the checkout is
// shallow, so the tags are fetched first (the workflow step does it); with no
// `v*` tag at all this FAILS: a check that cannot find its reference has
// proved nothing (invariant #4).
//
// Usage: node scripts/check-migration-order.mjs [--release <tag>]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationOrderViolations, newestReleaseTag } from './lib/migration-order.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL = 'packages/db/migrations/meta/_journal.json';

const git = (/** @type {string[]} */ args) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const at = process.argv.indexOf('--release');
const release = at >= 0 ? process.argv[at + 1] : newestReleaseTag(git(['tag', '--list', 'v*']));
if (!release) {
  console.error(
    'check-migration-order: no v* tag is reachable, so there is no release to compare the journal with.\n' +
      '  Fetch the tags first: git fetch --no-tags --depth=1 origin "+refs/tags/v*:refs/tags/v*"',
  );
  process.exit(1);
}

const released = JSON.parse(git(['show', `${release}:${JOURNAL}`])).entries;
const current = JSON.parse(readFileSync(resolve(repoRoot, JOURNAL), 'utf-8')).entries;
const violations = migrationOrderViolations({ tag: release, entries: released }, current);

if (violations.length > 0) {
  console.error(
    `check-migration-order: the journal breaks the order ${release} installs rely on:\n`,
  );
  for (const v of violations) console.error(`  - ${v.message}`);
  process.exit(1);
}
const added = current.filter((e) => !released.some((r) => r.tag === e.tag)).map((e) => e.tag);
console.log(
  `check-migration-order: ${release} shipped ${released.length} migrations, all unchanged; ` +
    `${added.length} added since, each later than all of them${added.length ? ` (${added.join(', ')})` : ''}.`,
);
