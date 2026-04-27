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
    AUTH_MODE: config.bind === 'lan' ? 'bearer-token' : 'local-trust',
    WORKER_SECRET: config.workerSecret,
    PORT: String(config.ports.runner),
    BIND: bind,
    APP_URL: `http://localhost:${config.ports.runner}`,
    NODE_ENV: 'production',
  };

  if (config.llm.apiKey) {
    env['LLM_API_KEY'] = config.llm.apiKey;
  }

  if (config.bind === 'lan' && config.bearerToken) {
    env['BEARER_TOKEN'] = config.bearerToken;
  }

  return env;
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

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    RUNNER_URL: `http://localhost:${config.ports.runner}`,
    AUTH_MODE: config.bind === 'lan' ? 'bearer-token' : 'local-trust',
    NEXT_PUBLIC_APP_URL: `http://localhost:${config.ports.web}`,
    PORT: String(config.ports.web),
    NODE_ENV: 'production',
    // In local-trust mode, we still need a valid AUTH_SECRET even if it's not used for session signing
    AUTH_SECRET: config.workerSecret,
    // LLM provider — mirrors buildEnvForRunner so the web can render the model dropdown
    LLM_PROVIDER: providerSlug,
    LLM_MODEL: config.llm.model,
    LLM_BASE_URL: config.llm.baseURL,
  };

  if (config.bind === 'lan' && config.bearerToken) {
    env['BEARER_TOKEN'] = config.bearerToken;
  }

  return env;
}

/**
 * Build the postgres connection URL given the data directory and port.
 */
export function buildDatabaseUrl(port: number): string {
  return `postgresql://nodalai:nodalai@localhost:${port}/nodalai`;
}
