import 'server-only';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path to the CLI's config file. Web and CLI co-exist on the same host;
 * both edit this file (CLI on `nodal-agents init`, web on Settings → Security).
 *
 * Override with `NODALAI_CONFIG_PATH` for tests / non-default home.
 */
export const NODALAI_CONFIG_PATH =
  process.env['NODALAI_CONFIG_PATH'] ?? join(homedir(), '.nodalai', 'config.json');

/**
 * Read the config JSON. Returns null when the file is missing OR malformed —
 * callers decide whether that's a hard error or a soft "first-run".
 */
export function readNodalaiConfig(): Record<string, unknown> | null {
  if (!existsSync(NODALAI_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(NODALAI_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Merge the given partial into the existing config and write it back.
 * Caller passes only the fields they want to change; other top-level keys
 * are preserved as-is so the CLI's untouched fields (LLM, ports, etc.)
 * survive a dashboard-driven update.
 *
 * Throws if the file doesn't exist (no point creating one from the web —
 * the CLI's `init` is the canonical bootstrap).
 */
export function mergeNodalaiConfig(patch: Record<string, unknown>): void {
  const existing = readNodalaiConfig();
  if (!existing) {
    throw new Error('cli_config_missing');
  }
  const next = { ...existing, ...patch };
  writeFileSync(NODALAI_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
}
