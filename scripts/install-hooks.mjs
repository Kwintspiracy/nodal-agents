#!/usr/bin/env node
// install-hooks.mjs — point git at the versioned .githooks/ directory.
//
// `core.hooksPath` is used instead of writing into .git/hooks/ so the hooks are
// reviewed, versioned, and identical on every machine — a hook that lives only
// in one developer's .git/ is a hook nobody else is protected by.
//
// Runs from `prepare`, i.e. after every `pnpm install`. It must therefore be
// silent and harmless anywhere it might run: a tarball install, a CI checkout
// with no git, a shallow clone.

import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS_DIR = '.githooks';

if (!existsSync('.git') || !existsSync(HOOKS_DIR)) {
  // Not a working clone (installed package, exported source, CI artefact).
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', HOOKS_DIR], { stdio: 'ignore' });
  // Git needs the executable bit on platforms that have one. Windows ignores it.
  for (const entry of readdirSync(HOOKS_DIR)) {
    try {
      chmodSync(join(HOOKS_DIR, entry), 0o755);
    } catch {
      /* filesystem without permission bits */
    }
  }
} catch {
  // No git binary, or a repo that forbids config writes. Hooks are a safety
  // net, never a build dependency — the same checks run in CI regardless.
  process.exit(0);
}
