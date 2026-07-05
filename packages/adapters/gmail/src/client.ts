// @nodal-agents/adapter-gmail — googleapis Gmail v1 client factory

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';

/**
 * Create a googleapis Gmail v1 instance whose access token is resolved lazily
 * — before every request — instead of captured once at construction time.
 *
 * Google OAuth access tokens live ~1h; a job can run far longer than that
 * (IDLE_RESET is 4h). Capturing a single token at setup meant a job outliving
 * that window got a spurious `gmail_unauthorized` even though the underlying
 * credential was still valid and refreshable (audit#2 M-12).
 *
 * `refreshHandler` is google-auth-library's supported extension point for
 * externally-managed tokens: OAuth2Client calls it whenever its cached token
 * is missing or (per `isTokenExpiring()`) expiring, instead of hitting
 * Google's own refresh endpoint. Returning an already-elapsed `expiry_date`
 * on every resolution forces `isTokenExpiring()` to be true again on the
 * NEXT request too, so `getAccessToken()` — which the runner wires to re-read
 * the credential row and trigger its existing advisory-lock refresh if the
 * stored token is genuinely stale — runs before every network call, not just
 * once at setup. The caller (runner) is still responsible for what
 * getAccessToken() does; if a call nonetheless returns 401 (e.g. the
 * credential was revoked), the tool throws
 * GmailAdapterError({ code: 'gmail_unauthorized' }).
 */
export function createGmailClient(getAccessToken: () => Promise<string>): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.refreshHandler = async () => ({
    access_token: await getAccessToken(),
    expiry_date: Date.now() - 1,
  });
  return google.gmail({ version: 'v1', auth });
}
