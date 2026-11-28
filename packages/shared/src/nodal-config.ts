// nodal-config.ts — le schéma de `config.json`, le fichier de réglages d'une instance.
//
// POURQUOI ICI (22/10/2026). Le schéma vivait dans le CLI (apps/cli/src/lib/config.ts),
// seul à écrire ce fichier. Le banc v2 monte sa propre instance de Nodal pour
// chaque campagne (ports, boucle locale, local-trust) : il écrit donc lui aussi
// un `config.json`, que le CLI relit au démarrage. Deux schémas auraient pu
// diverger en silence, et `readConfig` rend `null` sur un fichier invalide :
// `up` aurait alors écrit sa config par défaut, ports 3000/3001 compris, ceux de
// l'instance du propriétaire. Un seul schéma, ici ; le CLI le réexporte.
//
// Module sans dépendance Node : seulement zod. Le fichier lui-même se lit et
// s'écrit par `nodal-config-file.ts`, jamais à la main.
//
// UNKNOWN KEYS ARE KEPT (every object below is `.loose()`). A config written by
// a newer version and read by an older one must lose nothing when the older
// one saves it: a plain `z.object` drops what it does not know, and the next
// port change or key mint would have erased the newer version's settings.

import { z } from 'zod';

/**
 * How many copies of the database `up` keeps when `snapshots.keep` is not set
 * (packages/db/src/snapshots.ts takes them; `nodal-agents rollback` lists them).
 */
export const DEFAULT_SNAPSHOTS_KEPT = 2;

const PortsSchema = z
  .object({
    web: z.number().int().min(1024).max(65535).default(3000),
    runner: z.number().int().min(1024).max(65535).default(3001),
    postgres: z.number().int().min(1024).max(65535).default(25432),
  })
  .loose()
  // Three services, three ports. Two of them on one port is a configuration
  // that cannot start (one dies on EADDRINUSE, and the other answers the
  // first one's health check): refused, never saved.
  .refine(
    (p) => new Set([p.web, p.runner, p.postgres]).size === 3,
    'ports.web, ports.runner and ports.postgres must be three different ports',
  );

export const NodalConfigSchema = z
  .object({
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
      .loose()
      .optional(),
    ports: PortsSchema,
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
     * next boot (see rotatePostgresPassword in apps/cli/src/lib/postgres.ts) and
     * persists the new value here; until that succeeds, LEGACY_PG_PASSWORD is
     * what works.
     */
    postgresPassword: z.string().min(16).optional(),
    /**
     * A database password being moved to, not yet confirmed by the database.
     *
     * A password change has two steps that cannot be one: write the new value to
     * this file, then `ALTER USER` on the running cluster. A stop between the two
     * (a crash, a power cut, Ctrl+C) must lose neither value. So the new one is
     * written HERE first, beside the confirmed `postgresPassword`; it replaces it
     * only once the database has accepted it. The next start that finds this
     * field resumes the change: it connects with whichever of the two the
     * database accepts and finishes the move (`up`, apps/cli/src/commands/up.ts).
     */
    postgresPasswordPending: z.string().min(16).optional(),
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
      .loose()
      .optional(),
    /**
     * Nodal's page renderer (#1082), the window-less Chrome for Testing build
     * the `render_pdf` tool drives. `up` downloads it once, after the services
     * are healthy, unless `autoInstall` is `false` (or `up --skip-renderer-install`
     * is passed). Turned off, the tool says so and names
     * `nodal-agents renderer install`.
     */
    pageRenderer: z
      .object({
        autoInstall: z.boolean().optional(),
      })
      .loose()
      .optional(),
    /**
     * The copies of the database `up` takes before it migrates (inside the
     * cluster, with config.json and secrets.key beside each one). `keep` is
     * how many complete copies stay; older ones are dropped only once a new
     * one is complete. Default `DEFAULT_SNAPSHOTS_KEPT` (2). At least 1: the schema never moves
     * without a copy. Listed and swapped back by `nodal-agents rollback`.
     */
    snapshots: z
      .object({
        keep: z.number().int().min(1).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type NodalConfig = z.infer<typeof NodalConfigSchema>;
