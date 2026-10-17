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
  openSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isolatedNodalEnv } from './lib/nodal-home.mjs';
import { fileURLToPath } from 'node:url';
import { findGitDependencySpecs, formatGitDependencySpecs } from './lib/git-dependency-specs.mjs';

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

// NODALAI_HOME posé sous ce dossier, et les variables étroites du shell retirées :
// sans cela, un développeur qui en porte une enverrait l'essai dans SON instance.
const env = isolatedNodalEnv(process.env, homeDir);
const nodalDir = env.NODALAI_HOME;
const upLog = join(sandbox, 'up.log');
let failure = null;

try {
  // ── 3a. The install that boots is made WITHOUT git ───────────────────────
  // 0.9.6 installed only where git exists: @whiskeysockets/baileys declared
  // libsignal as a git URL, and npm failed with `spawn git ENOENT` on every
  // machine without git. CI runners have git, so the install passed here and
  // broke for users. npm runs git through its `git` setting; naming a command
  // that exists nowhere is what a machine without git looks like to npm (the
  // same `spawn … ENOENT`), on every OS. Stripping git from PATH is not
  // portable: on Linux /usr/bin holds git next to the sh npm runs scripts with.
  //
  // The npm doing it is the one a user has: NODAL_SMOKE_NPM=<version|tag>
  // installs with that npm (`npx npm@<it>`), else the npm on PATH. The CI runs
  // both the npm of the current Node LTS and npm latest: a registry change that
  // breaks an npm users have (16/10/2026: vitest 4.1.12 crashed every npm below
  // 11.6.0 inside better-auth's optional peers) turns CI red, not their install.
  const npm = process.env.NODAL_SMOKE_NPM ? `npx -y npm@${process.env.NODAL_SMOKE_NPM}` : 'npm';
  const npmVersion = execSync(`${npm} --version`, { encoding: 'utf-8' }).trim();
  const NO_GIT = 'nodal-smoke-no-git';
  step(`Installing into ${installDir} with npm ${npmVersion}, git unavailable to npm`);
  execSync('npm init -y', { cwd: installDir, stdio: 'ignore' });
  try {
    execSync(`${npm} install "${join(packDir, tarball)}" --no-audit --no-fund --loglevel=error`, {
      cwd: installDir,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, npm_config_git: NO_GIT },
    });
  } catch (e) {
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    process.stderr.write(output);
    if (output.includes(`spawn ${NO_GIT}`)) {
      throw new Error(
        'the tarball needs git to install: npm tried to run git for a dependency, ' +
          'and a machine without git fails right here (`spawn git ENOENT`)',
      );
    }
    throw new Error(`npm ${npmVersion} cannot install the tarball (see its output above)`);
  }

  const cli = join(installDir, 'node_modules', 'nodal-agents', 'cli.js');
  if (!existsSync(cli)) throw new Error(`installed package has no cli.js at ${cli}`);

  // ── 3b. No dependency resolved through git ────────────────────────────────
  // Scanned on a second install made WITH git, where every package is present:
  // without git npm drops an optional dependency that needs it in silence, so
  // the scan of the install above would never see it.
  const withGitDir = join(sandbox, 'install-with-git');
  step(`No dependency resolved through git (scan of an install made with git)`);
  mkdirSync(withGitDir, { recursive: true });
  execSync('npm init -y', { cwd: withGitDir, stdio: 'ignore' });
  execSync(`${npm} install "${join(packDir, tarball)}" --no-audit --no-fund --loglevel=error`, {
    cwd: withGitDir,
    stdio: 'inherit',
  });
  const gitReport = formatGitDependencySpecs(
    findGitDependencySpecs(join(withGitDir, 'node_modules')),
  );
  if (gitReport) throw new Error(gitReport);
  console.log('  ✔ every installed dependency comes from the registry');

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

  // ── 4b. The Windows sandbox carrier never lands on Linux (#628, D3) ────────
  // `nodal-agents-sandbox-windows` is `"os": ["win32"]`, so on this Linux
  // runner npm must skip it — and with it `@microsoft/mxc-sdk` and the native
  // `node-pty`. None of the three may appear anywhere in the installed tree.
  if (process.platform !== 'win32') {
    step('no Windows-only sandbox deps on Linux (#628)');
    const nm = join(installDir, 'node_modules');
    for (const dep of ['nodal-agents-sandbox-windows', '@microsoft/mxc-sdk', 'node-pty']) {
      const direct = join(nm, ...dep.split('/'));
      if (existsSync(direct)) {
        throw new Error(`${dep} was installed on ${process.platform}: ${direct}`);
      }
    }
    // Deep check: not hoisted anywhere under the install either.
    const offenders = [];
    const walk = (d, depth) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'node-pty' || e.name === 'mxc-sdk') offenders.push(join(d, e.name));
        if (e.name === 'node_modules' || e.name.startsWith('@')) walk(join(d, e.name), depth + 1);
      }
    };
    walk(nm, 0);
    if (offenders.length) {
      throw new Error(`Windows-only sandbox deps found on Linux:\n${offenders.join('\n')}`);
    }
    console.log('  none of nodal-agents-sandbox-windows / @microsoft/mxc-sdk / node-pty present ✓');
  }

  // ── 5. Configure ───────────────────────────────────────────────────────────
  step('nodal-agents init --non-interactive');
  execFileSync(process.execPath, [cli, 'init', '--non-interactive'], { env, stdio: 'inherit' });

  // Move off the default ports. Written directly rather than via a flag the CLI
  // does not expose; the shape mirrors what `init` produced one line above.
  const configPath = join(nodalDir, 'config.json');
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
  // already succeeded. A FILE holds nothing open the way a pipe does, so the
  // output of `up` goes to one, printed when the boot fails: until 0.9.7 an
  // `up` that refused to start said why to nobody.
  step('nodal-agents up  ← the gate');
  const upLogFd = openSync(upLog, 'w');
  const up = spawn(process.execPath, [cli, 'up'], {
    env,
    stdio: ['ignore', upLogFd, upLogFd],
    detached: false,
  });
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
  const webLog = join(nodalDir, 'logs', 'web.log');
  const runnerLog = join(nodalDir, 'logs', 'runner.log');
  for (const [label, path] of [
    ['nodal-agents up', upLog],
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
