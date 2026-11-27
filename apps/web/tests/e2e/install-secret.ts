// install-secret.ts — the proof the e2e helpers carry, read where the stack reads it.
//
// Both servers admit no caller without the install's secret, in every auth
// mode (packages/auth/src/lib/request-origin.ts): a probe sends it as a bearer,
// and in the mode with no password the browser enters through a launch link
// made from it, which leaves the dashboard cookie in the saved state. It is
// read from the config.json of the stack under test (NODALAI_HOME, or the
// default home), the file the CLI started that stack from. Never logged.

import { readFileSync } from 'node:fs';
import { nodalHomeEntry } from '@nodal-agents/shared/nodal-home';

export function installSecret(): string {
  const configPath = nodalHomeEntry('config.json');
  let secret: unknown;
  try {
    secret = (JSON.parse(readFileSync(configPath, 'utf8')) as { workerSecret?: unknown })
      .workerSecret;
  } catch (err) {
    throw new Error(
      `Cannot read ${configPath} (${(err as Error).message}): the install's secret lives there, ` +
        'and neither server admits a caller without it.',
    );
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new Error(`${configPath} carries no workerSecret.`);
  }
  return secret;
}

/** The header a probe of the stack sends. */
export function installProofHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${installSecret()}` };
}
