// install-secrets.test.ts — the runner's own secret values join every workspace's registry.
//
// What the runner process holds and no workspace owns: the database password
// (inside DATABASE_URL), the worker secret, the bearer token, a config-file
// provider key, and the master key in both encodings a text can carry it in.
// Values are built at run time; the master key is a fake one handed in.

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { runnerInstallSecretValues } from '../install-secrets.ts';

const value = (): string => randomBytes(12).toString('hex');

describe('the runner’s own secrets, for the tool-result registry @cap:connecter-un-service/moteur', () => {
  it('the database password, the worker secret, the bearer token, the provider key, the master key', () => {
    const password = `${value()}/+${value()}`;
    const worker = value();
    const bearer = value();
    const provider = value();
    const key = randomBytes(32);
    const values = runnerInstallSecretValues(
      {
        DATABASE_URL: `postgresql://nodal:${encodeURIComponent(password)}@127.0.0.1:5432/nodal`,
        WORKER_SECRET: worker,
        BEARER_TOKEN: bearer,
        LLM_API_KEY: provider,
      },
      () => key,
    );
    expect(values).toEqual([
      password,
      worker,
      bearer,
      provider,
      key.toString('base64'),
      key.toString('hex'),
    ]);
  });

  it('what is absent is not registered', () => {
    const key = randomBytes(32);
    const values = runnerInstallSecretValues(
      {
        DATABASE_URL: 'postgresql://127.0.0.1:5432/nodal',
        WORKER_SECRET: '',
        BEARER_TOKEN: undefined,
        LLM_API_KEY: undefined,
      },
      () => key,
    );
    expect(values).toEqual([key.toString('base64'), key.toString('hex')]);
  });
});
