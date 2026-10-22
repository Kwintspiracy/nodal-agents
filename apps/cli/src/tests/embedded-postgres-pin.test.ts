// embedded-postgres-pin.test.ts — embedded-postgres is pinned to an EXACT
// version, in the one place the published pack takes it from (#835, review
// pass 1).
//
// `up --detach` depends on two details of how that package (a beta) spawns
// postgres and hooks the process exit. A caret range lets a bump slip in on the
// next lockfile refresh, with no PR about it. A bump must be a deliberate PR
// whose tests run. (The published pack's deps are resolved to exact versions at
// build; its template must not say otherwise.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf-8');

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe('embedded-postgres is pinned exactly @cap:installer-et-demarrer/moteur', () => {
  const cli = JSON.parse(repo('apps/cli/package.json')) as {
    dependencies: Record<string, string>;
  };
  const pinned = cli.dependencies['embedded-postgres'];

  it('the CLI depends on an exact version, no range', () => {
    expect(pinned).toMatch(EXACT);
  });

  it('the lockfile records the same specifier', () => {
    const lock = repo('pnpm-lock.yaml');
    expect(lock).toContain(`embedded-postgres:\n        specifier: ${pinned}\n`);
  });

  it('the published pack takes the version from the CLI manifest, and refuses a range', () => {
    const build = repo('scripts/build-pack.mjs');
    // No second, hand-written copy of the range.
    expect(build).not.toMatch(/'embedded-postgres':\s*'/);
    expect(build).toContain("'embedded-postgres': embeddedPostgresVersion");
    expect(build).toMatch(/must pin embedded-postgres to an exact version/);
  });
});
