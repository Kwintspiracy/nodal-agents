#!/usr/bin/env node
// smoke-upgrade.mjs — install the PUBLISHED version, put real data in it, then
// upgrade to the local tarball and check it still boots and still has the data.
//
// Why this exists, and why `smoke-pack.mjs` is not enough:
//
//   `smoke-pack` installs the new tarball into an EMPTY home. That is the
//   fresh-install path. It says nothing about the path most people actually
//   take — `nodal-agents update` over an existing install, on top of a data
//   directory that already holds a config, a master key, and a Postgres cluster
//   several migrations old.
//
//   Every incident this product has had was on an upgrade or a fresh install,
//   never in the code: 0.8.0 shipped without 7 server chunks, 0.8.1 re-resolved
//   its own runtime three days after release. Both were invisible to the test
//   suite and obvious to anyone who installed.
//
// What this checks, in order:
//   1. the OLD published version installs and boots at all (baseline);
//   2. real state exists afterwards (config, master key, pg-data);
//   3. the NEW tarball installs OVER it;
//   4. it boots, serves a real page, and the state from step 2 is still there.
//
// Step 1 may legitimately fail — 0.8.1 is known broken since next@16.3.0 landed.
// That is reported and the run continues: the question that matters is whether
// the NEW version recovers a home directory written by the old one.
//
// Isolated HOME/USERPROFILE throughout: the developer's own ~/.nodalai is never
// touched. Ports are off the defaults so a running instance is never disturbed.
//
// Usage:
//   node scripts/smoke-upgrade.mjs                 # upgrade from npm latest
//   node scripts/smoke-upgrade.mjs --from 0.8.1    # upgrade from a given version
//
// Exit 0 = an existing install can move to this tarball and keep working.

import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packDir = join(repoRoot, 'pack');

const fromArgIndex = process.argv.indexOf('--from');
const FROM_VERSION = fromArgIndex >= 0 ? process.argv[fromArgIndex + 1] : 'latest';

// Deliberately off the defaults AND off smoke-pack's, so this can run beside
// both a developer instance and a pack smoke without colliding.
const PORTS = { web: 3310, runner: 3311, postgres: 25740 };

function step(msg) {
  console.log(`\n▶ ${msg}`);
}
function ok(msg) {
  console.log(`  ✔ ${msg}`);
}
function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

/** Wait for a URL to answer 2xx, or give up. Returns true on success. */
async function waitForHttp(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Boot an install and wait for the dashboard. Returns the child so the caller
 * can stop it. Never throws on boot failure — the caller decides what a failure
 * means, because for the OLD version a failure is expected news, not an error.
 */
async function boot(cli, env, label) {
  step(`${label}: nodal-agents up`);
  const child = spawn(process.execPath, [cli, 'up'], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const healthy = await waitForHttp(`http://localhost:${PORTS.web}/api/health`, 300_000);
  return { child, healthy };
}

async function stop(cli, env, child) {
  try {
    execFileSync(process.execPath, [cli, 'down'], { env, stdio: 'inherit', timeout: 120_000 });
  } catch {
    /* best-effort */
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'nodal-upgrade-'));
const installDir = join(sandbox, 'install');
const homeDir = join(sandbox, 'home');
mkdirSync(installDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
const cli = join(installDir, 'node_modules', 'nodal-agents', 'cli.js');

let failure = null;

try {
  // ── 1. The OLD published version ───────────────────────────────────────────
  step(`Installing nodal-agents@${FROM_VERSION} (the version users are on)`);
  execSync('npm init -y', { cwd: installDir, stdio: 'ignore' });
  execSync(`npm install nodal-agents@${FROM_VERSION} --no-audit --no-fund --loglevel=error`, {
    cwd: installDir,
    stdio: 'inherit',
  });
  const oldVersion = JSON.parse(
    readFileSync(join(installDir, 'node_modules', 'nodal-agents', 'package.json'), 'utf-8'),
  ).version;
  ok(`installed ${oldVersion}`);

  step('Configuring the old install');
  execFileSync(process.execPath, [cli, 'init', '--non-interactive'], { env, stdio: 'inherit' });
  const configPath = join(homeDir, '.nodalai', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.ports = PORTS;
  config.bind = 'loopback';
  delete config.auth;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  const oldBoot = await boot(cli, env, `${oldVersion}`);
  if (oldBoot.healthy) {
    ok(`${oldVersion} boots — this is the baseline`);
  } else {
    // Expected for 0.8.1 since next@16.3.0. Not a reason to stop: what we are
    // really testing is whether the NEW version can recover this home dir.
    warn(`${oldVersion} did NOT become healthy — continuing, the upgrade is the point`);
  }
  await stop(cli, env, oldBoot.child);

  // ── 2. Prove there is real state to preserve ───────────────────────────────
  step('Checking the old install left real state behind');
  const stateFiles = [
    join(homeDir, '.nodalai', 'config.json'),
    join(homeDir, '.nodalai', 'secrets.key'),
    join(homeDir, '.nodalai', 'pg-data', 'PG_VERSION'),
  ];
  const present = stateFiles.filter((f) => existsSync(f));
  for (const f of present) ok(`present: ${f.replace(homeDir, '~')}`);
  if (!present.includes(stateFiles[0])) {
    throw new Error('the old install wrote no config.json — nothing to upgrade from');
  }
  const masterKeyBefore = existsSync(stateFiles[1]) ? readFileSync(stateFiles[1], 'utf-8') : null;

  // ── 3. Upgrade to the local tarball ────────────────────────────────────────
  const tarball = `nodal-agents-${JSON.parse(readFileSync(join(packDir, 'package.json'), 'utf-8')).version}.tgz`;
  const tarballPath = join(packDir, tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(`no tarball at ${tarballPath} — run: cd pack && npm pack`);
  }

  step(`Upgrading in place → ${tarball}`);
  execSync(`npm install "${tarballPath}" --no-audit --no-fund --loglevel=error`, {
    cwd: installDir,
    stdio: 'inherit',
  });
  const newVersion = JSON.parse(
    readFileSync(join(installDir, 'node_modules', 'nodal-agents', 'package.json'), 'utf-8'),
  ).version;
  ok(`now on ${newVersion}`);
  if (newVersion === oldVersion) {
    throw new Error(`upgrade was a no-op: still on ${oldVersion}`);
  }

  // ── 4. The gate: does it boot on the OLD data? ─────────────────────────────
  const newBoot = await boot(cli, env, `${newVersion} (upgraded)`);
  if (!newBoot.healthy) {
    throw new Error(
      `${newVersion} did not become healthy after upgrading from ${oldVersion} — ` +
        `this is exactly the failure users hit`,
    );
  }
  ok('runner + web healthy');

  // /api/health alone proved nothing in 0.8.0: every page 500'd while it stayed
  // green. Fetch a real page.
  step('Fetching a real dashboard page');
  const pageRes = await fetch(`http://localhost:${PORTS.web}/`, {
    signal: AbortSignal.timeout(30_000),
  });
  const html = await pageRes.text();
  if (!pageRes.ok || !html.includes('<h1')) {
    throw new Error(`the dashboard did not render after upgrade (HTTP ${pageRes.status})`);
  }
  ok('dashboard renders');

  // ── 5. The data survived ───────────────────────────────────────────────────
  step('Checking the existing data survived the upgrade');
  if (masterKeyBefore !== null) {
    const after = readFileSync(stateFiles[1], 'utf-8');
    if (after !== masterKeyBefore) {
      throw new Error(
        'the master key CHANGED during the upgrade — every encrypted credential ' +
          'and LLM key in the database would be permanently unreadable',
      );
    }
    ok('master key unchanged (encrypted rows stay readable)');
  }
  if (!existsSync(stateFiles[2])) {
    throw new Error('pg-data disappeared during the upgrade — the user lost their database');
  }
  ok('pg-data preserved');

  await stop(cli, env, newBoot.child);

  console.log(
    `\n✅ ${oldVersion} → ${newVersion}: an existing install upgrades, boots, serves, and keeps its data.`,
  );
} catch (err) {
  failure = err;
  console.error(`\n❌ ${err.message}`);
} finally {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows may hold a handle briefly; the temp dir is disposable */
  }
}

process.exit(failure ? 1 : 0);
