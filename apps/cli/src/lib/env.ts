// env.ts — build environment variable maps for runner and web processes

import type { Config } from './config.ts';
import { getInstalledVersion } from './version.ts';

/**
 * Build env vars for the runner process.
 * Runner expects DATABASE_URL, LLM_*, AUTH_MODE, WORKER_SECRET, PORT, BIND.
 */
export function buildEnvForRunner(config: Config, databaseUrl: string): Record<string, string> {
  const bind = config.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    AUTH_MODE: resolveAuthMode(config),
    WORKER_SECRET: config.workerSecret,
    PORT: String(config.ports.runner),
    BIND: bind,
    APP_URL: `http://localhost:${config.ports.runner}`,
    NODE_ENV: 'production',
  };

  // llm section is optional (Brique 25): runner reads LLM config from DB at
  // runtime. Set env vars when present so the seeder can populate entity_llm_keys
  // on first boot; omit them if the section is absent (DB-only installs).
  if (config.llm) {
    const providerSlug =
      config.llm.provider === 'lm-studio' ||
      config.llm.provider === 'jan-ai' ||
      config.llm.provider === 'llamacpp' ||
      config.llm.provider === 'vllm'
        ? 'openai-compatible'
        : config.llm.provider;

    env['LLM_PROVIDER'] = providerSlug;
    env['LLM_MODEL'] = config.llm.model;
    env['LLM_BASE_URL'] = config.llm.baseURL;

    if (config.llm.apiKey) {
      env['LLM_API_KEY'] = config.llm.apiKey;
    }
  }

  return env;
}

/**
 * Resolve the auth mode for runtime processes.
 * Explicit `config.auth.mode` wins; otherwise we fall back to the legacy
 * mapping (loopback → local-trust, lan → local-auth).
 */
export function resolveAuthMode(config: Config): 'local-trust' | 'local-auth' {
  if (config.auth?.mode) return config.auth.mode;
  return config.bind === 'lan' ? 'local-auth' : 'local-trust';
}

/**
 * Build env vars for the web (Next.js) process.
 * Web expects DATABASE_URL, RUNNER_URL, AUTH_MODE, AUTH_SECRET, NEXT_PUBLIC_APP_URL.
 */
export function buildEnvForWeb(config: Config, databaseUrl: string): Record<string, string> {
  const authMode = resolveAuthMode(config);
  const bind = config.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    // 127.0.0.1, not localhost: on Windows localhost prefers IPv6 (::1), letting a
    // foreign IPv6 server on the runner port silently steal the web→runner traffic.
    RUNNER_URL: `http://127.0.0.1:${config.ports.runner}`,
    AUTH_MODE: authMode,
    // Expose auth mode to the client so login/page.tsx can render the right form.
    NEXT_PUBLIC_AUTH_MODE: authMode,
    NEXT_PUBLIC_APP_URL: `http://localhost:${config.ports.web}`,
    // The running CLI version — the web's update badge (sidebar) compares this
    // against the npm `latest` to tell the user when to run `nodal-agents update`.
    NODAL_VERSION: getInstalledVersion(),
    PORT: String(config.ports.web),
    // BIND mirrors the runner's binding so /settings → Network can render the
    // "restart required" banner when the configured value drifts from runtime.
    // The web itself doesn't bind on this — Next.js listens on 0.0.0.0 anyway.
    BIND: bind,
    NODE_ENV: 'production',
    // AUTH_SECRET is required by better-auth in local-auth mode; harmless in local-trust.
    AUTH_SECRET: config.workerSecret,
    // WORKER_SECRET — same value as the runner — so sendTaskAction can sign
    // the POST /api/worker call. Without this the runner returns 403 and the
    // job stays pending forever (cron only scans task-board, not API jobs).
    WORKER_SECRET: config.workerSecret,
    // NEXT_SERVER_ACTIONS_ENCRYPTION_KEY — stabilises server action IDs across
    // dev server restarts. Without this Next.js auto-mints a new key on each
    // boot, invalidating action references in already-loaded pages
    // ("Server action was not found on the server" on next click).
    // readConfig() guarantees this is set (auto-mints on first read).
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: config.serverActionsKey ?? '',
    // The Next.js standalone server reads HOSTNAME for its listener bind
    // (defaults to '0.0.0.0' when unset). Some host environments set
    // HOSTNAME to an arbitrary identifier (e.g. a runner ID), which Next
    // would interpret as the hostname to bind on — usually resolving via
    // /etc/hosts to 127.0.0.1 only, breaking port forwarding and the
    // `localhost:3000` healthcheck. Pin to the loopback/lan choice.
    HOSTNAME: bind,
  };

  // llm section is optional (Brique 25): set LLM_* env vars for the web's
  // model dropdown only when the section is present.
  if (config.llm) {
    const providerSlug =
      config.llm.provider === 'lm-studio' ||
      config.llm.provider === 'jan-ai' ||
      config.llm.provider === 'llamacpp' ||
      config.llm.provider === 'vllm'
        ? 'openai-compatible'
        : config.llm.provider;

    env['LLM_PROVIDER'] = providerSlug;
    env['LLM_MODEL'] = config.llm.model;
    env['LLM_BASE_URL'] = config.llm.baseURL;
  }

  // Surface Google OAuth creds to the web process when configured. Required
  // for better-auth's Google provider in local-auth mode; ignored otherwise.
  if (config.auth?.googleClientId) env['GOOGLE_CLIENT_ID'] = config.auth.googleClientId;
  if (config.auth?.googleClientSecret) {
    env['GOOGLE_CLIENT_SECRET'] = config.auth.googleClientSecret;
  }

  return env;
}

/**
 * Build the postgres connection URL given the data directory and port.
 */
export function buildDatabaseUrl(port: number): string {
  return `postgresql://nodalai:nodalai@localhost:${port}/nodalai`;
}
