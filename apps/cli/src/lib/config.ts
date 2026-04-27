// config.ts — config schema, read/write helpers, and config directory management

import { z } from 'zod';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  llm: z.object({
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
  }),
  ports: z.object({
    web: z.number().int().min(1024).max(65535).default(3000),
    runner: z.number().int().min(1024).max(65535).default(3001),
    postgres: z.number().int().min(1024).max(65535).default(54329),
  }),
  workerSecret: z.string().min(32),
  bind: z.enum(['loopback', 'lan']).default('loopback'),
  bearerToken: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LlmProvider = Config['llm']['provider'];

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
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as unknown;
    return ConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

export function writeConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
