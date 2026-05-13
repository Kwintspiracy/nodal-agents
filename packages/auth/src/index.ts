// @nodal-agents/auth — pluggable AuthProvider abstraction.
// Three implementations: local-trust (default), local-auth (better-auth),
// bearer-token (LAN mode).

export type { AuthSession, AuthProvider } from './types.ts';
export { AuthError, NoEntityError } from './types.ts';
export type { AuthErrorCode, NoEntityErrorCode } from './types.ts';

// AnyDrizzleDb is owned by @nodal-agents/db; re-export for convenience.
export type { AnyDrizzleDb } from '@nodal-agents/db';

export {
  LocalTrustProvider,
  seedLocalUser,
  LOCAL_USER_ID,
  LOCAL_ENTITY_ID,
} from './providers/local-trust.ts';

export {
  LocalAuthProvider,
  createLocalAuthProvider,
  isGoogleConfigured,
} from './providers/local-auth.ts';
export type { LocalAuthProviderOptions } from './providers/local-auth.ts';

export { BearerTokenProvider } from './providers/bearer-token.ts';
export type { BearerTokenProviderOptions } from './providers/bearer-token.ts';

export { requireAuth, requireAuthWithEntity } from './helpers.ts';

// Re-export the Next.js handler helper so apps/web can call it without
// importing better-auth directly (apps/web doesn't list better-auth as a dep).
export { toNextJsHandler } from 'better-auth/next-js';
