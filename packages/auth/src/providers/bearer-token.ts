// bearer-token provider — LAN mode.
// Reads Authorization: Bearer <token> header and compares against a
// configured token. Returns the local user session on match, null otherwise.

import type { AuthProvider, AuthSession } from '../types.ts';
import { LOCAL_USER_ID, LOCAL_ENTITY_ID } from './local-trust.ts';
import { constantTimeEqual } from '../lib/constant-time.ts';

export interface BearerTokenProviderOptions {
  /** The expected bearer token value (from ~/.nodalai/config.json). */
  token: string;
}

export class BearerTokenProvider implements AuthProvider {
  readonly #token: string;

  constructor(options: BearerTokenProviderOptions) {
    this.#token = options.token;
  }

  getSession(req: Request): Promise<AuthSession | null> {
    const authorization = req.headers.get('Authorization');
    if (!authorization) return Promise.resolve(null);

    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
      return Promise.resolve(null);
    }

    const provided = parts[1];
    // Constant-time: a naive !== leaks how many leading bytes matched via
    // response timing — a side channel on an API token guarding the LAN.
    if (!provided || !constantTimeEqual(provided, this.#token)) return Promise.resolve(null);

    return Promise.resolve({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  }
}
