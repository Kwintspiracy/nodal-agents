import 'server-only';

import type { NodalConfig } from '@nodal-agents/shared/nodal-config';
import { readNodalConfigFile, updateNodalConfigFile } from '@nodal-agents/shared/nodal-config-file';
import { nodalConfigPath } from '@nodal-agents/shared/state-files';

/**
 * Path to the CLI's config file. Web and CLI co-exist on the same host;
 * both edit this file (CLI on `nodal-agents init`, web on Settings → Security).
 *
 * `<NODALAI_HOME>/config.json` — the home the CLI handed to this process — and
 * `NODALAI_CONFIG_PATH` still wins for this one file, for the CLI as well.
 */
export const NODALAI_CONFIG_PATH = nodalConfigPath();

/**
 * Read the config. Null means the file does NOT exist, and only that. A file
 * that exists but cannot be read or understood throws `StateFileError`, whose
 * message names the file and says how to recover: it is never reported as
 * missing, and the dashboard never advises `init` over it.
 *
 * Same reader as the CLI (`@nodal-agents/shared/nodal-config-file`).
 */
export function readNodalaiConfig(): NodalConfig | null {
  return readNodalConfigFile(NODALAI_CONFIG_PATH);
}

/**
 * Merge the given partial into the existing config and write it back,
 * atomically, keeping the previous version as `config.json.last-good`.
 * Caller passes only the fields they want to change; every other key is kept
 * as it was, including keys this version does not know.
 *
 * Throws `StateFileError`: `STATE_FILE_ABSENT` when there is no file (the CLI
 * creates it, never the web), `STATE_FILE_INVALID` / `STATE_FILE_UNREADABLE`
 * when the file is unusable or the merge would make it invalid. Nothing is
 * written in any of those cases.
 */
export function mergeNodalaiConfig(patch: Partial<NodalConfig>): void {
  updateNodalConfigFile(NODALAI_CONFIG_PATH, (current) => ({ ...current, ...patch }));
}
