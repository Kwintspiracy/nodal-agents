// @nodalai/adapter-google-drive — googleapis Drive v3 client factory

import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';

/**
 * Create a googleapis Drive v3 instance authenticated with an OAuth access token.
 *
 * The caller (runner) is responsible for token refresh — if a call returns 401,
 * the tool throws DriveAdapterError({ code: 'drive_unauthorized' }).
 * The adapter never attempts refresh internally.
 */
export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}
