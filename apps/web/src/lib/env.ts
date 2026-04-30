import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  RUNNER_URL: z.string().url().default('http://localhost:3001'),
  AUTH_MODE: z.enum(['local-trust', 'local-auth', 'bearer-token']).default('local-trust'),
  // NEXT_PUBLIC_AUTH_MODE mirrors AUTH_MODE and is safe to read client-side.
  // Must be set explicitly by the CLI (buildEnvForWeb) so the login page can
  // detect local-auth mode without a server round-trip.
  NEXT_PUBLIC_AUTH_MODE: z
    .enum(['local-trust', 'local-auth', 'bearer-token'])
    .default('local-trust'),
  AUTH_SECRET: z.string().min(32).optional(),
  // Shared with the runner. Required for sendTaskAction to authenticate its
  // POST /api/worker call. Optional in tests (where the worker isn't pinged).
  WORKER_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  // Public URL the runner is reachable at — required for Telegram webhook
  // registration. Optional: if absent, the dashboard saves the bot token but
  // tells the user to expose the runner publicly before incoming messages
  // can be received. Configured by CLI via buildEnvForWeb() once we add a
  // public-URL flag, otherwise user sets it manually.
  RUNNER_PUBLIC_URL: z.string().url().optional(),
  // LLM provider configuration — set by CLI via buildEnvForWeb()
  LLM_PROVIDER: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
});

// Build-time validation: if DATABASE_URL is absent (e.g. during static `next build`
// with no .env), use a placeholder that satisfies the schema but will fail at
// runtime if a DB call is actually made.
const raw = {
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://placeholder:5432/placeholder',
  RUNNER_URL: process.env['RUNNER_URL'],
  AUTH_MODE: process.env['AUTH_MODE'],
  NEXT_PUBLIC_AUTH_MODE: process.env['NEXT_PUBLIC_AUTH_MODE'],
  AUTH_SECRET: process.env['AUTH_SECRET'],
  WORKER_SECRET: process.env['WORKER_SECRET'],
  GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
  GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
  NEXT_PUBLIC_APP_URL: process.env['NEXT_PUBLIC_APP_URL'],
  RUNNER_PUBLIC_URL: process.env['RUNNER_PUBLIC_URL'],
  LLM_PROVIDER: process.env['LLM_PROVIDER'],
  LLM_MODEL: process.env['LLM_MODEL'],
  LLM_BASE_URL: process.env['LLM_BASE_URL'],
};

export const env = envSchema.parse(raw);
