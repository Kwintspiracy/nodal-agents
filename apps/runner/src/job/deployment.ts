// job/deployment.ts — compute the DeploymentContext injected into every
// agent's system prompt as a `## Runtime` block.
//
// CRITICAL: reads env via process.env DIRECTLY — NOT the `env` proxy from
// ../env.ts. The proxy validates the ENTIRE runner env on first access and
// THROWS if DATABASE_URL (or any required var) is absent. This helper may
// run on paths without full env (cron bootstrap, tool-only invocations), so
// bypassing the proxy is a hard requirement. See: commit fixing execute.ts:835
// for the cron-path regression this pattern caused.

import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { getInstallNotes } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DeploymentContext } from '@nodal-agents/orchestration';

/**
 * Map process.platform to a human-readable OS name for the Runtime block.
 */
function detectOs(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/**
 * Collect non-internal IPv4 addresses from all network interfaces.
 * Replicates apps/web/src/lib/network.ts getLanAddresses() locally
 * (no cross-app imports allowed per architecture rules).
 */
function getLanAddresses(): string[] {
  const ifaces = networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push(iface.address);
      }
    }
  }
  return out;
}

/**
 * Compute the DeploymentContext for this runner instance.
 *
 * Reads env via process.env directly (see module-level CRITICAL note).
 * Performs a single DB read for operator install notes.
 */
export async function getDeploymentContext(db: AnyDrizzleDb): Promise<DeploymentContext> {
  // Determine network mode from BIND env var. '0.0.0.0' or '::' = LAN.
  const bind = process.env['BIND'] ?? '127.0.0.1';
  const networkMode: 'loopback' | 'lan' = bind === '0.0.0.0' || bind === '::' ? 'lan' : 'loopback';

  const authMode = process.env['AUTH_MODE'] ?? 'local-trust';

  const lanAddresses = networkMode === 'lan' ? getLanAddresses() : undefined;

  // Containerized: check for /.dockerenv (Docker standard) or explicit env flag.
  const containerized =
    existsSync('/.dockerenv') || !!process.env['NODALAI_CONTAINER'] || undefined;

  // Guard: app_settings table may not exist on older installs (pre-migration 0045).
  // A missing table is not a fatal error — just omit install notes gracefully.
  const installNotes = await getInstallNotes(db).catch(() => '');

  return {
    os: detectOs(),
    networkMode,
    authMode,
    ...(lanAddresses !== undefined ? { lanAddresses } : {}),
    ...(containerized ? { containerized } : {}),
    ...(installNotes ? { installNotes } : {}),
  };
}
