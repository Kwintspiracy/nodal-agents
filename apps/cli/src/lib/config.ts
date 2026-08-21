// config.ts — config schema, read/write helpers, and config directory management

import { z } from 'zod';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

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

export const ConfigSchema = z.object({
  /**
   * LLM provider configuration.
   * Optional since Brique 25: existing installs that have removed the `llm`
   * section from config.json don't fail validation. The runner reads LLM config
   * from entity_llm_keys at runtime; the `llm` section is only used by the
   * seeder on first boot and by the web's model dropdown.
   * New installs created via `nodal-agents init` still write this section.
   */
  llm: z
    .object({
      provider: z.enum([
        'ollama',
        'lm-studio',
        'jan-ai',
        'llamacpp',
        'vllm',
        'openai-compatible',
        'anthropic',
        'openai',
        'openrouter',
      ]),
      baseURL: z.string().url(),
      model: z.string().min(1),
      apiKey: z.string().optional(),
    })
    .optional(),
  ports: z.object({
    web: z.number().int().min(1024).max(65535).default(3000),
    runner: z.number().int().min(1024).max(65535).default(3001),
    postgres: z.number().int().min(1024).max(65535).default(25432),
  }),
  workerSecret: z.string().min(32),
  /**
   * Base64-encoded 32-byte AES key fed to Next.js as
   * NEXT_SERVER_ACTIONS_ENCRYPTION_KEY. Persisted in config.json so server
   * action IDs stay valid across dev server restarts — without this, pages
   * loaded before a restart hit "Server action was not found on the server"
   * the next time the user clicks a server-action button.
   *
   * Optional in the schema for back-compat with pre-existing config.json
   * files; `readConfig` auto-mints + persists when absent.
   */
  serverActionsKey: z.string().length(44).optional(),
  /**
   * Base64-encoded 32-byte AES key used as better-auth's AUTH_SECRET (session
   * cookie signing) for the web process. Deliberately SEPARATE from
   * `workerSecret` (M-4): `workerSecret` is the runner's auth frontier — a
   * leak of it must not also let an attacker forge a signed session cookie.
   *
   * Optional in the schema for back-compat with pre-existing config.json
   * files; `readConfig` auto-mints + persists when absent. On an existing
   * install this invalidates any active better-auth sessions ONCE (users
   * re-login) — an acceptable one-time cost for closing the amplification.
   */
  authSecret: z.string().length(44).optional(),
  /**
   * Password for the embedded Postgres role, minted per install.
   *
   * SECRET-003 (audit 2026-08-07). Both the role and the password used to be the
   * literal `nodalai`, hardcoded and identical on every installation, on a
   * predictable port. Any process or second account on the machine could open
   * the database directly — reading transcripts, memory and connector tokens —
   * without going near the file ACLs that protect secrets.key.
   *
   * Optional for back-compat: an install created before this field exists has a
   * cluster whose role still carries the old password. `up` rotates it on the
   * next boot (see rotatePostgresPassword in lib/postgres.ts) and persists the
   * new value here; until that succeeds, LEGACY_PG_PASSWORD is what works.
   */
  postgresPassword: z.string().min(16).optional(),
  bind: z.enum(['loopback', 'lan']).default('loopback'),
  bearerToken: z.string().optional(),
  /**
   * Auth provider override. When unset, the auth mode is derived from `bind`
   * (loopback → local-trust, lan → local-auth). Set explicitly to enable
   * email+password (and optionally Google OAuth) on a loopback install.
   *
   * Edited from the dashboard via Settings → Security; CLI restart required.
   */
  auth: z
    .object({
      mode: z.enum(['local-trust', 'local-auth']).optional(),
      googleClientId: z.string().optional(),
      googleClientSecret: z.string().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LlmProvider = NonNullable<Config['llm']>['provider'];

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CONFIG_DIR = join(homedir(), '.nodalai');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const PID_DIR = join(CONFIG_DIR, 'pids');
export const LOG_DIR = join(CONFIG_DIR, 'logs');
export const PG_DATA_DIR = join(CONFIG_DIR, 'pg-data');

export function ensureConfigDir(): void {
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
