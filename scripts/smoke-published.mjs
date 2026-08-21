#!/usr/bin/env node
// smoke-published.mjs — install what the REGISTRY actually serves, and boot it.
//
// Run this after every `npm publish`, before telling anyone the release is out.
//
// ## Why a local pack smoke is not this test
//
// `smoke-pack` proves the tarball on disk works. `smoke-upgrade` proves an
// existing install can move onto that tarball. Neither touches npm, and both of
// this product's release incidents happened in the gap they leave:
//
//   - 0.8.0 published a tarball missing 7 server chunks. The build was fine; the
//     thing that shipped was not.
//   - 0.8.1 published correctly and broke three days later, when npm started
//     pairing its pre-compiled bundle with a newer `next` that its own floating
//     ranges allowed.
//
// Both were invisible locally and obvious to anyone who ran `npm install`. So
// the only honest final check installs from the registry, by version, the way a
// stranger would — no local files involved anywhere in the chain.
//
// Isolated HOME/USERPROFILE and non-default ports throughout: the developer's
// own ~/.nodalai is never touched, and a running instance is never disturbed.
//
// Usage:
//   node scripts/smoke-published.mjs            # whatever `latest` points at
//   node scripts/smoke-published.mjs 0.8.5      # a specific version
//
// Exit 0 = a stranger can install this version today and it works.

import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WANTED = process.argv[2] ?? 'latest';

// Off the defaults AND off both other smokes, so all three can run back to back.
const PORTS = { web: 3410, runner: 3411, postgres: 25840 };

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);

async function waitForHttp(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

const sandbox = mkdtempSync(join(tmpdir(), 'nodal-published-'));
const installDir = join(sandbox, 'install');
const homeDir = join(sandbox, 'home');
mkdirSync(installDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
const cli = join(installDir, 'node_modules', 'nodal-agents', 'cli.js');

let child = null;
let failure = null;

try {
  step(`Installing nodal-agents@${WANTED} from the public registry`);
  execSync('npm init -y', { cwd: installDir, stdio: 'ignore' });
  // --registry is explicit so a machine with a private mirror configured still
  // tests what the public world gets.
  execSync(
    `npm install nodal-agents@${WANTED} --registry=https://registry.npmjs.org ` +
      '--no-audit --no-fund --loglevel=error',
    { cwd: installDir, stdio: 'inherit' },
  );

  const installed = JSON.parse(
    readFileSync(join(installDir, 'node_modules', 'nodal-agents', 'package.json'), 'utf-8'),
  );
  ok(`installed ${installed.version}`);

  // The 0.8.1 failure mode, checked directly rather than inferred from a boot:
  // a pre-compiled bundle whose dependencies are declared as ranges will
  // re-resolve itself weeks later, on a machine we will never see.
  step('Checking no dependency can drift after publication');
  const floating = Object.entries(installed.dependencies ?? {}).filter(([, v]) =>
    /^[\^~>=<]|\s\|\|\s|\*/.test(v),
  );
  if (floating.length > 0) {
    throw new Error(
      `${floating.length} dependency range(s) shipped — this package can re-resolve its ` +
        `own runtime later, which is exactly how 0.8.1 died:\n` +
        floating.map(([k, v]) => `    ${k}: ${v}`).join('\n'),
    );
  }
  ok(`all ${Object.keys(installed.dependencies ?? {}).length} dependencies pinned exactly`);

  step('Configuring');
  execFileSync(process.execPath, [cli, 'init', '--non-interactive'], { env, stdio: 'inherit' });
  const configPath = join(homeDir, '.nodalai', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.ports = PORTS;
  config.bind = 'loopback';
  delete config.auth;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  step('nodal-agents up  ← the gate');
  child = spawn(process.execPath, [cli, 'up'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (!(await waitForHttp(`http://localhost:${PORTS.web}/api/health`, 300_000))) {
    throw new Error(`nodal-agents@${installed.version} never became healthy from a clean install`);
  }
  ok('runner + web healthy');

  // /api/health proved nothing in 0.8.0: it stayed green while every page 500'd.
  step('Fetching a real dashboard page');
  const res = await fetch(`http://localhost:${PORTS.web}/`, {
    signal: AbortSignal.timeout(30_000),
  });
  const html = await res.text();
  if (!res.ok || !html.includes('<h1')) {
    throw new Error(`the dashboard did not render (HTTP ${res.status})`);
  }
  ok('dashboard renders');

  console.log(
    `\n✅ nodal-agents@${installed.version}, installed from npm, boots and serves. ` +
      `This is what a stranger gets today.`,
  );
} catch (err) {
  failure = err;
  console.error(`\n❌ ${err.message}`);
} finally {
  try {
    execFileSync(process.execPath, [cli, 'down'], { env, stdio: 'inherit', timeout: 120_000 });
  } catch {
    /* best-effort */
  }
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  try {
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows may hold a handle briefly; the temp dir is disposable */
  }
}

process.exit(failure ? 1 : 0);
