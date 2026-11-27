// lib/dashboard-link.ts — the address that opens this install's dashboard.
//
// In the mode with no password, the dashboard lets a browser in only through a
// launch link made from the install's secret (packages/auth/src/lib/launch-link.ts):
// it works once, within LAUNCH_TTL_MS, and leaves a cookie that keeps the
// browser in. `up` opens one when the stack is ready, `nodal-agents open`
// makes another (a second browser profile, an expired link). In the modes
// with a sign-in, the address is the dashboard itself: the person signs in.
//
// Every program of this install that calls the runner or the dashboard proves
// who it is with the same secret, as a bearer (lib/install-proof.ts).

import { LAUNCH_TTL_MS, launchUrl } from '@nodal-agents/auth/launch-link';
import type { Config } from './config.ts';
import { resolveAuthMode } from './env.ts';

export interface DashboardEntry {
  /** What to open in a browser. */
  url: string;
  /** True for a launch link: it works once, within `LAUNCH_TTL_MS`. */
  oneTime: boolean;
}

/** The dashboard's own address for this install. */
export function dashboardBaseUrl(config: Pick<Config, 'ports'>): string {
  return `http://localhost:${config.ports.web}/`;
}

export function dashboardEntry(config: Config, now: number = Date.now()): DashboardEntry {
  const base = dashboardBaseUrl(config);
  if (resolveAuthMode(config) !== 'local-trust') return { url: base, oneTime: false };
  return { url: launchUrl(base, config.workerSecret, now), oneTime: true };
}

/** How long a launch link waits, in whole minutes, for the words that say so. */
export const LAUNCH_TTL_MINUTES = Math.round(LAUNCH_TTL_MS / 60_000);
