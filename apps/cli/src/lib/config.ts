// config.ts — config schema, read/write helpers, and config directory management

import { dirname, join } from 'path';
import { mkdirSync, existsSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { nodalHome } from '@nodal-agents/shared/nodal-home';
import { openNodalHome } from '@nodal-agents/shared/nodal-instances';
import { NodalConfigSchema, type NodalConfig } from '@nodal-agents/shared/nodal-config';
import {
  createNodalConfigFile,
  readNodalConfigFile,
  writeNodalConfigFile,
} from '@nodal-agents/shared/nodal-config-file';
import {
  StateFileError,
  lastGoodCopyPath,
  masterKeyFilePath,
  nodalConfigPath,
  processesFilePath,
} from '@nodal-agents/shared/state-files';

/**
 * Same restriction, for a DIRECTORY and everything created inside it.
 *
 * SECRET-002 (audit 2026-08-07). The file-level hardening above works — verified
 * with `icacls` on a real install: config.json and secrets.key each showed
 * `<user>:(F)` alone, inheritance stripped. But it was only ever applied to
 * those two files. The DIRECTORIES kept the profile's inherited ACL:
 *
 *   pg-data\  NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
 *             BUILTIN\Administrators:(I)(OI)(CI)(F)
 *             <user>:(I)(OI)(CI)(F)
 *
 * pg-data holds the entire database — transcripts, memory, connector tokens — so
 * a second standard account on the machine could read everything without ever
 * touching secrets.key. `(OI)(CI)` makes the grant inheritable so files created
 * later (new WAL segments, rotated logs) are covered too.
 */
function restrictDirToOwner(path: string): void {
  try {
    chmodSync(path, 0o700); // POSIX; no-op on Windows
  } catch {
    /* ignore */
  }
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'] || process.env['USER'];
  if (!user) return;
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      stdio: 'ignore',
    });
  } catch {
    /* best-effort: a directory we could not tighten is still usable */
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

// Le schéma vit dans @nodal-agents/shared (nodal-config.ts) : le banc écrit lui
// aussi un config.json, celui de l'instance d'une campagne, et le CLI le relit.
export const ConfigSchema = NodalConfigSchema;

export type Config = NodalConfig;
export type LlmProvider = NonNullable<Config['llm']>['provider'];

// ─── Paths ────────────────────────────────────────────────────────────────────

// Le dossier de Nodal : `NODALAI_HOME`, ou `~/.nodalai` (packages/shared/src/nodal-home.ts).
// Lu une fois, au chargement : une valeur invalide fait échouer le CLI au
// démarrage (index.ts le dit proprement), jamais à mi-chemin d'un `up`.
export const CONFIG_DIR = nodalHome();
export const CONFIG_FILE = nodalConfigPath();
export const PID_DIR = join(CONFIG_DIR, 'pids');
export const PROCESSES_FILE = processesFilePath();
export const LOG_DIR = join(CONFIG_DIR, 'logs');
export const PG_DATA_DIR = join(CONFIG_DIR, 'pg-data');

export function ensureConfigDir(): void {
  // Le dossier lui-même d'abord, par la porte commune : inscrit au registre des
  // instances (le bac à sable des AUTRES le refuse dès lors), puis créé. S'il ne
  // peut pas l'être, le message nomme le dossier et la variable.
  openNodalHome();
  // NODALAI_CONFIG_PATH peut mettre config.json ailleurs que sous le dossier.
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  for (const dir of [CONFIG_DIR, PID_DIR, LOG_DIR, PG_DATA_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // SECRET-002: applied on every call, not only at creation — existing
    // installs were made before this and would otherwise keep the inherited ACL
    // forever. Idempotent and cheap.
    restrictDirToOwner(dir);
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * The config, or null when there is NO config file. A file that exists but
 * cannot be read or understood throws `StateFileError` (it names the file, says
 * nothing was changed, and how to recover): no caller may take it for "absent",
 * because "absent" leads to writing a new config, and the old one holds the
 * only copy of the database password (B38-02).
 */
export function readConfig(configFile: string = CONFIG_FILE): Config | null {
  let parsed = readNodalConfigFile(configFile);
  if (parsed === null) return null;

  // Auto-migrate: ensure serverActionsKey exists for pre-existing configs.
  // Without this, Next.js server actions break across dev restarts.
  if (!parsed.serverActionsKey) {
    parsed = { ...parsed, serverActionsKey: randomBytes(32).toString('base64') };
    writeConfig(parsed, configFile);
  }

  // Auto-migrate: ensure authSecret exists and is DISTINCT from workerSecret
  // (M-4). Pre-existing configs minted before this fix have no authSecret at
  // all (better-auth fell back to workerSecret in env.ts); mint one now so
  // the two secrets are separate going forward. This invalidates active
  // better-auth sessions once — users re-login.
  if (!parsed.authSecret) {
    parsed = { ...parsed, authSecret: randomBytes(32).toString('base64') };
    writeConfig(parsed, configFile);
  }

  // Best-effort tighten permissions on configs written before M-5. No-op on
  // Windows (chmod doesn't map to NTFS ACLs) and non-fatal on any error —
  // this is a defense-in-depth pass, not load-bearing for boot.
  if (configFile === CONFIG_FILE) {
    try {
      chmodSync(configFile, 0o600);
    } catch {
      /* best-effort */
    }
  }

  return parsed;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Replace the config with `config`, atomically, keeping the previous version as
 * `config.json.last-good` (packages/shared/src/state-files.ts). Keys this
 * version does not know are part of `config` (the schema keeps them) and are
 * written back as they were.
 */
export function writeConfig(config: Config, configFile: string = CONFIG_FILE): void {
  // When writing to the default location, ensure the .nodalai dir tree exists.
  // For custom test paths the caller is responsible for prepping the dir.
  if (configFile === CONFIG_FILE) ensureConfigDir();
  writeNodalConfigFile(configFile, config);
}

// ─── A new install ────────────────────────────────────────────────────────────

/** What a home that already holds an install has on disk, without a config. */
export interface InstallEvidence {
  /** The database cluster (`pg-data/PG_VERSION`). */
  readonly pgData: string;
  /** The master key. */
  readonly masterKey: string;
}

export function installEvidence(): InstallEvidence {
  return { pgData: PG_DATA_DIR, masterKey: masterKeyFilePath() };
}

/**
 * The config of a NEW install: fresh secrets, the default ports, and the
 * database password minted NOW, before the cluster exists, so `initdb` is
 * given it directly and a new install never goes through a password change.
 */
export function newInstallConfig(choices: Partial<Config> = {}): Config {
  return NodalConfigSchema.parse({
    ports: { web: 3000, runner: 3001, postgres: 25432 },
    workerSecret: randomBytes(32).toString('hex'),
    serverActionsKey: randomBytes(32).toString('base64'),
    // M-4: distinct from workerSecret.
    authSecret: randomBytes(32).toString('base64'),
    postgresPassword: randomBytes(24).toString('base64url'),
    bind: 'loopback',
    ...choices,
  });
}

/**
 * Create the config of a new install. "New" is a fact about the home, not
 * about the config file alone: a home whose config is missing but which still
 * holds a database, a master key or a last good copy of the config IS an
 * install, and a new config would carry a database password that database does
 * not know. That is refused, nothing is written, and the message says what to
 * put back.
 */
export function createConfig(
  config: Config,
  configFile: string = CONFIG_FILE,
  evidence: InstallEvidence = installEvidence(),
): void {
  const found = [
    existsSync(join(evidence.pgData, 'PG_VERSION')) ? `a database (${evidence.pgData})` : null,
    existsSync(evidence.masterKey) ? `a master key (${evidence.masterKey})` : null,
    existsSync(lastGoodCopyPath(configFile))
      ? `a last good copy of the config (${lastGoodCopyPath(configFile)})`
      : null,
  ].filter((f): f is string => f !== null);
  if (found.length > 0) {
    const restore = existsSync(lastGoodCopyPath(configFile))
      ? `Copy ${lastGoodCopyPath(configFile)} to ${configFile}, then run the command again.`
      : `Put back ${configFile} from a backup, then run the command again. It holds the ` +
        'password of the database: a new one would not open it.';
    throw new StateFileError(
      'STATE_FILE_ABSENT',
      configFile,
      `${configFile} is missing, but this folder already holds an install: ${found.join(', ')}.\n` +
        'Nothing was written: a new configuration would not know the password of that database.\n' +
        restore,
    );
  }
  if (configFile === CONFIG_FILE) ensureConfigDir();
  createNodalConfigFile(configFile, config);
}
