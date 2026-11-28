// lib/install-proof.ts — what every program of this install sends to prove who it is.
//
// The runner and the dashboard admit no caller without the install's secret
// (the `workerSecret` of config.json, which only the owner's account can
// read), in every auth mode (packages/auth/src/lib/request-origin.ts). The
// CLI's probes and calls send it as a bearer.

export function installProof(workerSecret: string): Record<string, string> {
  if (workerSecret === '') {
    // Invariant #4: a probe without the proof would read every answer as a 401.
    throw new Error('install_secret_missing: config.json carries no workerSecret');
  }
  return { Authorization: `Bearer ${workerSecret}` };
}
