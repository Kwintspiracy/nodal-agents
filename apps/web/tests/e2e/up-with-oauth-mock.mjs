#!/usr/bin/env node
// up-with-oauth-mock.mjs — wraps `nodal-agents up` with NODALAI_ALLOW_OAUTH_MOCK=1
// forced on, so the OAuth e2e specs (oauth-flow, notion-oauth, credentials-reuse,
// airtable-oauth) that drive the callback route with a synthetic "mock-"
// authorization code work with ZERO extra manual setup — `pnpm e2e:up` is the
// supported way to bring the stack up for e2e (I-9, audit #2 round 2).
//
// The flag is only ever forced HERE, never in a normal `nodal-agents up`: the
// bypass stays dead in every real dev/prod boot (see the gate in
// apps/web/src/app/api/oauth/[provider]/callback/route.ts).
//
// Any extra CLI args (e.g. `--dev`) are forwarded to `nodal-agents up`.

import { spawn } from 'node:child_process';

const args = ['up', ...process.argv.slice(2)];

const child = spawn('nodal-agents', args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODALAI_ALLOW_OAUTH_MOCK: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`[e2e:up] Failed to launch \`nodal-agents up\`: ${err.message}`);
  process.exit(1);
});
