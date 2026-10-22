#!/usr/bin/env node
// check-npm-floor.mjs — the npm smoke-pack.mjs will install with is at or above
// the floor the install docs promise. Usage: node scripts/check-npm-floor.mjs 11.6.0
//
// The npm is the one smoke-pack.mjs picks: NODAL_SMOKE_NPM=<version|tag> means
// `npx npm@<it>`, else the npm on PATH. A CI leg whose npm fell below the floor
// would be testing an npm the docs already tell users to leave: it fails here,
// by name, instead of passing or failing for a reason nobody reads.

import { execSync } from 'node:child_process';
import { compareVersions, npmUnderTest } from './lib/npm-floor.mjs';

const floor = process.argv[2];
if (!floor) {
  console.error('usage: node scripts/check-npm-floor.mjs <floor version>');
  process.exit(1);
}
const npm = npmUnderTest(process.env.NODAL_SMOKE_NPM);
const version = execSync(`${npm} --version`, { encoding: 'utf-8' }).trim();
if (compareVersions(version, floor) < 0) {
  console.error(`❌ npm ${version} is below the floor ${floor}`);
  process.exit(1);
}
console.log(`✔ npm ${version} (floor ${floor})`);
