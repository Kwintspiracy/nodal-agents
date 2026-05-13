// @nodal-agents/adapter-google-docs — googleapis Docs v1 client factory

import { google } from 'googleapis';
import type { docs_v1 } from 'googleapis';

/**
 * Create a googleapis Docs v1 instance authenticated with an OAuth access token.
 *
 * The caller (runner) is responsible for token refresh — if a call returns 401,
 * the tool throws DocsAdapterError({ code: 'docs_unauthorized' }).
 * The adapter never attempts refresh internally.
 */
export function createDocsClient(accessToken: string): docs_v1.Docs {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.docs({ version: 'v1', auth });
}
