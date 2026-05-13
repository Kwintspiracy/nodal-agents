// @nodal-agents/adapter-gmail — googleapis Gmail v1 client factory

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';

/**
 * Create a googleapis Gmail v1 instance authenticated with an OAuth access token.
 *
 * The caller (runner) is responsible for token refresh — if a call returns 401,
 * the tool throws GmailAdapterError({ code: 'gmail_unauthorized' }).
 * The adapter never attempts refresh internally.
 */
export function createGmailClient(accessToken: string): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}
