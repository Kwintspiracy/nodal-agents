// @nodal-agents/adapter-google-calendar — googleapis Calendar v3 client factory

import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';

/**
 * Create a googleapis Calendar v3 instance authenticated with an OAuth access token.
 *
 * The caller (runner) is responsible for token refresh — if a call returns 401,
 * the tool throws GoogleCalendarAdapterError({ code: 'gcal_unauthorized' }).
 * The adapter never attempts refresh internally.
 */
export function createGoogleCalendarClient(accessToken: string): calendar_v3.Calendar {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: 'v3', auth });
}
