// nodal-config-file.ts — reading and writing `config.json`, for the CLI, the
// dashboard and the bench alike.
//
// The file goes through `state-files.ts` (atomic replace, last good copy, an
// unusable file is a refusal, never "absent"). This module adds what is proper
// to `config.json`: its schema, its serialisation, and the words a person reads
// when it is unusable. Every program that touches the file calls these
// functions; none opens it itself (the architecture test of this package
// refuses a direct write).

import { NodalConfigSchema, type NodalConfig } from './nodal-config';
import {
  createStateFile,
  readStateFile,
  replaceStateFile,
  StateFileError,
  type StateFileSpec,
  type StateFileWriteSeams,
} from './state-files';

function parseConfigText(text: string): NodalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`it is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = NodalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(the whole file)'}: ${i.message}`)
      .join('; ');
    throw new Error(`it does not match the expected settings (${issues})`);
  }
  return parsed.data;
}

export const NODAL_CONFIG_FILE: StateFileSpec<NodalConfig> = {
  label: "Nodal's configuration file",
  parse: parseConfigText,
  keepsLastGood: true,
  recovery:
    'It holds the password of the database and the secrets of this install: do not delete it. ' +
    'Fix it by hand (it is JSON), or put back a copy from a backup, then run the command again.',
};

/** The bytes written for a config: what every writer writes, byte for byte. */
export function serializeNodalConfig(config: NodalConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The config at `path`, or null when there is NO file there. A file that
 * exists but cannot be read or does not match the schema throws
 * `StateFileError`: it is never answered as null.
 */
export function readNodalConfigFile(path: string): NodalConfig | null {
  return readStateFile(path, NODAL_CONFIG_FILE);
}

/**
 * Replace the config at `path` with `config`, atomically, keeping the previous
 * version as `config.json.last-good`. Refuses a config the schema refuses, and
 * refuses to write over an existing file that is itself unusable.
 */
export function writeNodalConfigFile(
  path: string,
  config: NodalConfig,
  seams: StateFileWriteSeams = {},
): void {
  replaceStateFile(path, serializeNodalConfig(config), NODAL_CONFIG_FILE, seams);
}

/**
 * Create the config of a NEW install at `path`. Refuses when a file is already
 * there (`StateFileError` `STATE_FILE_EXISTS`): creating is never a way to
 * replace.
 */
export function createNodalConfigFile(path: string, config: NodalConfig): void {
  createStateFile(path, serializeNodalConfig(config), NODAL_CONFIG_FILE);
}

/**
 * Read the config at `path`, change it with `change`, write it back. The keys
 * `change` does not touch are kept as they were, including keys this version
 * does not know. Throws `StateFileError` when the file is absent (there is
 * nothing to change: the CLI creates it) or unusable, and when the changed
 * config would not be valid.
 */
export function updateNodalConfigFile(
  path: string,
  change: (current: NodalConfig) => NodalConfig,
): NodalConfig {
  const current = readNodalConfigFile(path);
  if (current === null) {
    throw new StateFileError(
      'STATE_FILE_ABSENT',
      path,
      `${NODAL_CONFIG_FILE.label} at ${path} does not exist: there is nothing to change. ` +
        'The CLI creates it on the first `nodal-agents up` (or `nodal-agents init`).',
    );
  }
  const next = change(current);
  writeNodalConfigFile(path, next);
  return next;
}
