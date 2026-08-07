#!/usr/bin/env node
// smoke-pack.mjs — pack, install clean, BOOT, assert both services serve, stop.
//
// SUPPLY-001 (audit 2026-08-07). Two releases in a row shipped a tarball whose
// dashboard never came up, and neither was caught before publish:
//
//   0.8.0 — Next's standalone copy dropped 7 server chunks. Every dashboard page
//           500ed while /api/health stayed 200.
//   0.8.1 — the manifest carried `next: "^16.2.6"` beside a PRE-BUILT bundle.
//           The day next@16.3.0 landed, every fresh install crashed on boot.
//           Nothing was missing from the tarball, so the 0.8.0 chunk gate could
//           not see it — and no commit changed.
//
// What both have in common: the only thing that would have caught them is
// actually STARTING the packed product. `verify-install.mjs` checks that deps
// resolve and chunks are present — necessary, not sufficient. `pnpm build`
// builds the workspace, not the tarball. This script closes that gap.
//
// The CLI's own `assertWebRenders` guard already makes `up` exit non-zero when
// the dashboard does not render — verified against a deliberately broken install
// (next@16.3.0): exit code 1, "Service at http://localhost:PORT did not become
// healthy". That exit code is honoured here, but it is not the whole assertion:
// this script also probes both services itself and fetches a real PAGE, because
// 0.8.0 shipped with /api/health green on both while every dashboard route 500ed.
//
// Usage:
//   node scripts/smoke-pack.mjs              # pack, then boot
//   node scripts/smoke-pack.mjs --no-build   # reuse an existing pack/
//
// Exit 0 = a fresh install of this tarball boots and serves. Exit 1 = it does not.

import { execFileSync, execSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packDir = join(repoRoot, 'pack');
const skipBuild = process.argv.includes('--no-build');

// Ports deliberately off the defaults so a developer's own instance on
// 3000/3001/25432 is never touched, and a CI runner never collides with itself.
const PORTS = { web: 3210, runner: 3211, postgres: 25640 };

function step(msg) {
  console.log(`\n▶ ${msg}`);
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

// ── 1. Build the pack ────────────────────────────────────────────────────────
if (!skipBuild) {
  step('Building pack');
  run('node scripts/build-pack.mjs');
} else if (!existsSync(join(packDir, 'package.json'))) {
  console.error('❌ --no-build passed but pack/ has no package.json. Run without --no-build.');
  process.exit(1);
}

// ── 2. Tarball ───────────────────────────────────────────────────────────────
step('Creating tarball');
run('npm pack --silent', { cwd: packDir });
const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
if (!tarball) {
  console.error('❌ npm pack produced no .tgz in pack/');
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(packDir, 'package.json'), 'utf-8')).version;
console.log(`  ${tarball} (version ${version})`);

// ── 3. Clean install in an isolated HOME ─────────────────────────────────────
// A dedicated HOME/USERPROFILE keeps ~/.nodalai (config, master key, pg-data)
// away from the developer's real install — this must never touch it.
const sandbox = mkdtempSync(join(tmpdir(), 'nodal-smoke-'));
const installDir = join(sandbox, 'install');
const homeDir = join(sandbox, 'home');
mkdirSync(installDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
let failure = null;

try {
  step(`Installing into ${installDir}`);
  execSync('npm init -y', { cwd: installDir, stdio: 'ignore' });
  execSync(`npm install "${join(packDir, tarball)}" --no-audit --no-fund --loglevel=error`, {
    cwd: installDir,
    stdio: 'inherit',
  });

  const cli = join(installDir, 'node_modules', 'nodal-agents', 'cli.js');
  if (!existsSync(cli)) throw new Error(`installed package has no cli.js at ${cli}`);

  // ── 4. Dependency + chunk integrity on the INSTALLED tree ──────────────────
  step('verify-install (deps resolve, chunks present)');
  execFileSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/verify-install.mjs'),
      join(installDir, 'node_modules', 'nodal-agents'),
    ],
    { stdio: 'inherit' },
  );

  // ── 5. Configure ───────────────────────────────────────────────────────────
  step('nodal-agents init --non-interactive');
  execFileSync(process.execPath, [cli, 'init', '--non-interactive'], { env, stdio: 'inherit' });

  // Move off the default ports. Written directly rather than via a flag the CLI
  // does not expose; the shape mirrors what `init` produced one line above.
  const configPath = join(homeDir, '.nodalai', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.ports = PORTS;
  // Loopback + local-trust is the DEFAULT a normal user gets from the wizard,
  // so that is what the smoke test must exercise (init --non-interactive writes
  // lan/local-auth, which is the container preset, not the common path).
  config.bind = 'loopback';
  delete config.auth;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // ── 6. THE GATE: boot it ───────────────────────────────────────────────────
  // `up` starts Postgres, the runner and the web, then DETACHES and leaves them
  // running. It must be spawned, not exec'd synchronously: the detached children
  // inherit the parent's stdio handles, so `execFileSync(..., 'inherit')` blocks
  // until they die — observed here, hanging for 25 minutes after the boot had
  // already succeeded. `stdio: 'ignore'` gives the children nothing to hold.
  step('nodal-agents up  ← the gate');
  const up = spawn(process.execPath, [cli, 'up'], { env, stdio: 'ignore', detached: false });
  // `up` exits 0 once everything is healthy and leaves the services running, so
  // a plain await would hang. Record the code as it arrives and let the probes
  // below decide — a NON-ZERO exit means the boot failed and there is nothing
  // left to wait for.
  let upExitCode = null;
  up.on('exit', (code) => {
    upExitCode = code ?? 1;
  });

  // Assert on the SERVICES, not only on `up`'s exit code. 0.8.0 shipped with
  // /api/health answering 200 on both while every dashboard PAGE 500ed, so a
  // health probe alone is not the claim a release makes — fetch a real page too.
  const deadline = Date.now() + 10 * 60_000;
  const probes = [
    { label: 'runner /api/health', url: `http://127.0.0.1:${PORTS.runner}/api/health` },
    { label: 'web /api/health', url: `http://127.0.0.1:${PORTS.web}/api/health` },
    { label: 'web page render', url: `http://127.0.0.1:${PORTS.web}/`, page: true },
  ];

  for (const probe of probes) {
    let ok = false;
    let lastStatus = 'no response';
    while (Date.now() < deadline) {
      // A failed `up` means nothing will ever answer — report the real reason
      // instead of burning the full ten-minute budget.
      if (upExitCode !== null && upExitCode !== 0) {
        throw new Error(
          `nodal-agents up exited with code ${upExitCode} before ${probe.label} answered`,
        );
      }
      try {
        const res = await fetch(probe.url, { redirect: 'follow' });
        lastStatus = `HTTP ${res.status}`;
        // A page must actually render, not merely respond: 0.8.0's dashboard
        // returned 500 on every route while health stayed green.
        if (res.ok) {
          ok = true;
          break;
        }
      } catch (e) {
        lastStatus = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    if (!ok) throw new Error(`${probe.label} never became healthy (last: ${lastStatus})`);
    console.log(`  ✔ ${probe.label}`);
  }

  console.log(`\n✅ A clean install of nodal-agents@${version} boots and serves.`);
} catch (err) {
  failure = err;
  console.error(`\n❌ Packed install failed to boot: ${err instanceof Error ? err.message : err}`);
  const webLog = join(homeDir, '.nodalai', 'logs', 'web.log');
  const runnerLog = join(homeDir, '.nodalai', 'logs', 'runner.log');
  for (const [label, path] of [
    ['web.log', webLog],
    ['runner.log', runnerLog],
  ]) {
    if (existsSync(path)) {
      console.error(`\n──── ${label} (tail) ────`);
      console.error(readFileSync(path, 'utf-8').split('\n').slice(-40).join('\n'));
    }
  }
} finally {
  // ── 7. Always stop, always clean ──────────────────────────────────────────
  const cli = join(installDir, 'node_modules', 'nodal-agents', 'cli.js');
  if (existsSync(cli)) {
    try {
      execFileSync(process.execPath, [cli, 'down'], { env, stdio: 'inherit' });
    } catch {
      /* best-effort: the gate's verdict matters more than a tidy shutdown */
    }
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows may hold a handle on pg-data briefly — a temp dir left behind
       is not worth failing the run over */
  }
}

process.exit(failure ? 1 : 0);
