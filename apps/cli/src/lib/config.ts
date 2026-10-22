// config.ts — config schema, read/write helpers, and config directory management

import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { nodalHome, nodalHomeEntry } from '@nodal-agents/shared/nodal-home';
import { openNodalHome } from '@nodal-agents/shared/nodal-instances';
import { NodalConfigSchema, type NodalConfig } from '@nodal-agents/shared/nodal-config';

/**
 * Restrict config.json (workerSecret / authSecret / LLM + OAuth secrets) to its
 * owner on all platforms (FA-5). `chmod 0600` is a no-op on Windows, where the
 * file inherits the parent dir's ACL — so strip inheritance and grant the
 * current user only, via `icacls`. Best-effort.
 */
function restrictFileToOwner(path: string): void {
  try {
    chmodSync(path, 0o600); // POSIX; no-op on Windows
  } catch {
    /* ignore */
  }
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'] || process.env['USER'];
  if (!user) return;
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
}

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
export const CONFIG_FILE = nodalHomeEntry('config.json');
export const PID_DIR = join(CONFIG_DIR, 'pids');
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

export function readConfig(configFile: string = CONFIG_FILE): Config | null {
  if (!existsSync(configFile)) return null;
  let parsed: Config;
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as unknown;
    parsed = ConfigSchema.parse(raw);
  } catch {
    return null;
  }

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

export function writeConfig(config: Config, configFile: string = CONFIG_FILE): void {
  // When writing to the default location, ensure the .nodalai dir tree exists.
  // For custom test paths the caller is responsible for prepping the dir.
  if (configFile === CONFIG_FILE) ensureConfigDir();
  // config.json holds workerSecret/authSecret/LLM+OAuth secrets in plaintext.
  // Mode 0600 restricts it to the owning user on POSIX; FA-5: on Windows that
  // mode is ignored, so restrictFileToOwner lays down an explicit owner-only
  // ACL via icacls instead of relying on the inherited profile-dir ACL.
  writeFileSync(configFile, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  restrictFileToOwner(configFile);
}
