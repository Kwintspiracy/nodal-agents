// setup-workspaces-root.ts — vitest setupFile (see ../../vitest.config.ts).
//
// Points the workspaces root (lib/workspaces-root.ts) at a per-run temp dir so
// suites that drive executeJob / channel handlers with synthetic entity ids
// never mkdir under the developer's real ~/.nodalai/workspaces. Before this
// guard, every gauntlet run leaked empty `<uuid>/shared` dirs into the real
// home directory (5k+ accumulated over a month).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['NODALAI_WORKSPACES_ROOT'] ??= mkdtempSync(join(tmpdir(), 'nodalai-test-ws-'));
