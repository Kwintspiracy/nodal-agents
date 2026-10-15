// setup-workspaces-root.ts — vitest setupFile, for the root config and apps/runner's.
//
// Points the workspaces root (packages/tools file-ops/workspaces-root.ts) at a per-run temp dir so
// suites that drive executeJob / channel handlers with synthetic entity ids
// never mkdir under the developer's real ~/.nodalai/workspaces. Before this
// guard, every gauntlet run leaked empty `<uuid>/shared` dirs into the real
// home directory (5k+ accumulated over a month).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['NODALAI_WORKSPACES_ROOT'] ??= mkdtempSync(join(tmpdir(), 'nodalai-test-ws-'));

// Same guard for the tool caches (#628, @nodal-agents/sandbox policy.ts): every
// command the shell engine runs gets npm_config_cache, PIP_CACHE_DIR… pointed
// at this root, and a suite that runs `npm install` must not fill the real
// ~/.nodalai/tool-cache.
process.env['NODALAI_TOOL_CACHE_ROOT'] ??= mkdtempSync(join(tmpdir(), 'nodalai-test-cache-'));

// And for the sandbox's own scripts (the job host, the MXC broker): written
// where Nodal keeps them, so a test run writes them to a temp dir instead.
process.env['NODALAI_SANDBOX_DIR'] ??= mkdtempSync(join(tmpdir(), 'nodalai-test-sandbox-'));

// Nodal's own ports, which the sandbox's proxy regime refuses (#628, P2-3:
// `nodalDeniedEndpoints` now FAILS LOUD when they are missing — never denies
// fewer in silence). In production the runner always sets them (apps/cli
// env.ts); so must the test harness, or on a machine where the OS sandbox is
// available (the owner's, under release:check) every confined command would be
// refused for want of this config. Notional values: no test reads them
// expecting the real test database (spinUpTestDb hands back a db handle, not an
// env var). A suite that needs specific ports (sandbox-proxy-windows) overrides
// them, since this is `??=`.
process.env['PORT'] ??= '3001';
process.env['WEB_PORT'] ??= '3000';
process.env['DATABASE_URL'] ??= 'postgres://nodal@127.0.0.1:25432/nodal';
