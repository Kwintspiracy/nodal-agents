// cloudflare_deploy pure seams: worker-name validation (doubles as the
// anti-injection guarantee on the npx .cmd shim path) and the wrangler argv.

import { describe, it, expect } from 'vitest';
import {
  WORKER_NAME_RE,
  buildWranglerDeployArgs,
  WRANGLER_SPEC,
  COMPATIBILITY_DATE,
} from '../index.ts';

describe('WORKER_NAME_RE', () => {
  it('accepts real worker names', () => {
    for (const ok of ['site', 'my-app-2', 'a', 'a1-b2-c3', 'x'.repeat(54)]) {
      expect(WORKER_NAME_RE.test(ok)).toBe(true);
    }
  });

  it('rejects names that could carry shell metacharacters or break the URL', () => {
    for (const bad of [
      '',
      'My-App', // uppercase
      '-lead', // leading dash
      'trail-', // trailing dash
      'a b',
      'x&whoami',
      'a|b',
      'a%b',
      'app.name',
      'x'.repeat(55),
    ]) {
      expect(WORKER_NAME_RE.test(bad)).toBe(false);
    }
  });
});

describe('buildWranglerDeployArgs', () => {
  it('pins wrangler major + compatibility date — no wrangler config file ever needed', () => {
    const args = buildWranglerDeployArgs('my-site', 'D:\\ws\\dist');
    expect(args).toEqual([
      '--yes',
      WRANGLER_SPEC,
      'deploy',
      '--name',
      'my-site',
      '--assets',
      'D:\\ws\\dist',
      '--compatibility-date',
      COMPATIBILITY_DATE,
    ]);
    expect(WRANGLER_SPEC).toMatch(/^wrangler@\d+$/); // major pin, never latest
    // wrangler refuses an upload with no compatibility date (proven live
    // 2026-08-20) — the flag must always be present, and pinned.
    expect(COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
