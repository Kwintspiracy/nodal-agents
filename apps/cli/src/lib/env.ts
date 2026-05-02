// env.ts — build environment variable maps for runner and web processes

import type { Config } from './config.ts';

/**
 * Build env vars for the runner process.
 * Runner expects DATABASE_URL, LLM_*, AUTH_MODE, WORKER_SECRET, PORT, BIND.
 */
export function buildEnvForRunner(config: Config, databaseUrl: string): Record<string, string> {
  const bind = config.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    LLM_PROVIDER:
      config.llm.provider === 'lm-studio'
        ? 'openai-compatible'
        : config.llm.provider === 'jan-ai'
          ? 'openai-compatible'
          : config.llm.provider === 'llamacpp'
            ? 'openai-compatible'
            : config.llm.provider === 'vllm'
              ? 'openai-compatible'
              : config.llm.provider,
    LLM_MODEL: config.llm.model,
    LLM_BASE_URL: config.llm.baseURL,
    AUTH_MODE: resolveAuthMode(config),
    WORKER_SECRET: config.workerSecret,
    PORT: String(config.ports.runner),
    BIND: bind,
    APP_URL: `http://localhost:${config.ports.runner}`,
    NODE_ENV: 'production',
  };

  if (config.llm.apiKey) {
    env['LLM_API_KEY'] = config.llm.apiKey;
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
  const providerSlug =
    config.llm.provider === 'lm-studio' ||
    config.llm.provider === 'jan-ai' ||
    config.llm.provider === 'llamacpp' ||
    config.llm.provider === 'vllm'
      ? 'openai-compatible'
      : config.llm.provider;

  const authMode = resolveAuthMode(config);

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    RUNNER_URL: `http://localhost:${config.ports.runner}`,
    AUTH_MODE: authMode,
    // Expose auth mode to the client so login/page.tsx can render the right form.
    NEXT_PUBLIC_AUTH_MODE: authMode,
    NEXT_PUBLIC_APP_URL: `http://localhost:${config.ports.web}`,
    PORT: String(config.ports.web),
    NODE_ENV: 'production',
    // AUTH_SECRET is required by better-auth in local-auth mode; harmless in local-trust.
    AUTH_SECRET: config.workerSecret,
    // WORKER_SECRET — same value as the runner — so sendTaskAction can sign
    // the POST /api/worker call. Without this the runner returns 403 and the
    // job stays pending forever (cron only scans task-board, not API jobs).
    WORKER_SECRET: config.workerSecret,
    // LLM provider — mirrors buildEnvForRunner so the web can render the model dropdown
    LLM_PROVIDER: providerSlug,
    LLM_MODEL: config.llm.model,
    LLM_BASE_URL: config.llm.baseURL,
  };

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
