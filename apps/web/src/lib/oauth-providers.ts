// oauth-providers.ts — re-exports from @nodalai/shared.
// The canonical registry has moved to packages/shared/src/oauth/providers.ts
// so that both the web app and the runner can consume it without circular deps.
// This file is kept for backwards compatibility with existing web app imports.

export { OAUTH_PROVIDERS, getOAuthProvider, getProviderByCredentialType } from '@nodalai/shared';
export type { OAuthProvider } from '@nodalai/shared';
