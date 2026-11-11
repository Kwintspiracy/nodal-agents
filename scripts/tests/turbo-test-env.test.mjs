// turbo-test-env.test.mjs — the `test` task passes through what a real
// process-table read needs on Windows (issue #1056).
//
// The first block proves the check on small configurations; the second applies
// it to the REAL turbo.json, so removing either variable fails here, naming the
// variable and the CI run that measured why.
//
// Run from the repo root: pnpm test:scripts

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  checkTestTaskEnv,
  describeTestEnvFinding,
  EVIDENCE_RUN,
  REQUIRED_TEST_ENV,
} from '../lib/turbo-test-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const withTest = (passThroughEnv) => ({ tasks: { test: { passThroughEnv } } });

describe('checkTestTaskEnv', () => {
  it('accepts a test task that passes both variables through', () => {
    expect(checkTestTaskEnv(withTest(['OS', 'PSModulePath', 'PSModuleAnalysisCachePath']))).toEqual(
      { ok: true },
    );
  });

  it('names the variable that is missing', () => {
    const result = checkTestTaskEnv(withTest(['OS', 'PSModulePath']));
    expect(result).toMatchObject({ ok: false, missing: ['PSModuleAnalysisCachePath'] });
    expect(describeTestEnvFinding(result)).toContain('PSModuleAnalysisCachePath');
    expect(describeTestEnvFinding(result)).toContain(`run ${EVIDENCE_RUN}`);
  });

  it('reads names case-insensitively, as Windows does', () => {
    expect(checkTestTaskEnv(withTest(['psmodulepath', 'PSMODULEANALYSISCACHEPATH']))).toEqual({
      ok: true,
    });
  });

  it('follows turbo wildcards and exclusions', () => {
    expect(checkTestTaskEnv(withTest(['PSModule*']))).toEqual({ ok: true });
    expect(checkTestTaskEnv(withTest(['PSModule*', '!PSModulePath']))).toMatchObject({
      ok: false,
      missing: ['PSModulePath'],
    });
  });

  it('refuses a configuration it cannot judge, never waves it through', () => {
    expect(checkTestTaskEnv({ tasks: {} })).toMatchObject({
      ok: false,
      why: expect.stringContaining('no `tasks.test`'),
    });
    expect(checkTestTaskEnv(withTest('PSModulePath'))).toMatchObject({ ok: false });
    expect(checkTestTaskEnv({ tasks: { test: {} } })).toMatchObject({
      ok: false,
      missing: [...REQUIRED_TEST_ENV],
    });
  });

  it('does not count the global list: the test task carries them itself', () => {
    const turbo = {
      globalPassThroughEnv: ['PSModulePath', 'PSModuleAnalysisCachePath'],
      tasks: { test: { passThroughEnv: ['OS'] } },
    };
    expect(checkTestTaskEnv(turbo)).toMatchObject({ ok: false, missing: [...REQUIRED_TEST_ENV] });
  });
});

describe('the real turbo.json', () => {
  it('passes PSModulePath and PSModuleAnalysisCachePath through to `test`', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
    const result = checkTestTaskEnv(turbo);
    expect(result, describeTestEnvFinding(result)).toEqual({ ok: true });
  });
});
