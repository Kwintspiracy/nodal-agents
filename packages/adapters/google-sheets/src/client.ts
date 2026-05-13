// @nodal-agents/adapter-google-sheets — googleapis Sheets v4 client factory

import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

/**
 * Create a googleapis Sheets v4 instance authenticated with an OAuth access token.
 *
 * The caller (runner) is responsible for token refresh — if a call returns 401,
 * the tool throws SheetsAdapterError({ code: 'sheets_unauthorized' }).
 * The adapter never attempts refresh internally.
 */
export function createSheetsClient(accessToken: string): sheets_v4.Sheets {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth });
}
