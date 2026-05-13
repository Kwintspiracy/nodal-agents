// oauth-providers.ts — re-exports from @nodal-agents/shared.
// The canonical registry has moved to packages/shared/src/oauth/providers.ts
// so that both the web app and the runner can consume it without circular deps.
// This file is kept for backwards compatibility with existing web app imports.

export {
  OAUTH_PROVIDERS,
  getOAuthProvider,
  getProviderByCredentialType,
} from '@nodal-agents/shared';
export type { OAuthProvider } from '@nodal-agents/shared';
