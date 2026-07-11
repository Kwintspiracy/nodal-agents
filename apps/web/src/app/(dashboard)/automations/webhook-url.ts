/**
 * composeWebhookUrl — turns the relative `/webhooks/:slug/:secret` path returned
 * by createWebhookTriggerAction/rotateWebhookSecretAction into a URL the
 * external service can actually POST to. The runner is a separate process from
 * the dashboard, always on port 3001 (see apps/web/src/lib/env.ts's
 * RUNNER_URL default) — composed client-side from the CURRENT hostname so a
 * LAN-accessed dashboard produces a LAN-reachable webhook URL instead of a
 * server-side loopback address.
 */
export function composeWebhookUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.protocol}//${window.location.hostname}:3001${path}`;
}
