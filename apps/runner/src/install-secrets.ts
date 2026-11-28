// install-secrets.ts — the runner's own secret values, for the tool-result registry.
//
// Every workspace's registry holds the install's own secrets
// (`registerInstallSecretValues`, packages/shared/src/secret-registry.ts):
// the values this process holds, which no workspace owns and none may read in
// a tool result. They are registered once, at start, from what the runner was
// given: the database password (in `DATABASE_URL`), the worker secret, the
// bearer token of the bearer mode, the provider key of a config-file install,
// and the master key that decrypts every stored credential, in the two
// encodings a text can carry it in.
//
// The web's session secret (`AUTH_SECRET`) is the web process's: the runner is
// never given it, so it cannot reach a tool result through the runner.

import { loadOrCreateMasterKey } from '@nodal-agents/secrets';
import type { RunnerEnv } from './env.ts';

/** The password written in a database URL, or null. */
function databasePassword(url: string): string | null {
  try {
    const password = new URL(url).password;
    return password === '' ? null : decodeURIComponent(password);
  } catch {
    // Not a URL this runner could have connected with: nothing to register.
    return null;
  }
}

/** The secret values the runner process holds. Never logged. */
export function runnerInstallSecretValues(
  env: Pick<RunnerEnv, 'DATABASE_URL' | 'WORKER_SECRET' | 'BEARER_TOKEN' | 'LLM_API_KEY'>,
  masterKey: () => Buffer = () => loadOrCreateMasterKey(),
): string[] {
  const key = masterKey();
  return [
    databasePassword(env.DATABASE_URL),
    env.WORKER_SECRET,
    env.BEARER_TOKEN,
    env.LLM_API_KEY,
    key.toString('base64'),
    key.toString('hex'),
  ].filter((v): v is string => typeof v === 'string' && v !== '');
}
