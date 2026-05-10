# Adding a new OAuth provider

How to wire a new OAuth 2.0 provider (Slack, GitHub, Discord, Linear, …) into NodalAI's credentials system. The plumbing is data-driven — there is no per-provider runtime code, only registry entries, a UI guide, and a DB constraint update. Counting realistically, ~20 minutes per provider for the standard OAuth 2.0 case.

This doc is the source of truth for the procedure. Read it end to end the first time. The 5-file checklist is below; the rest of the doc is the rationale and edge cases.

## TL;DR — the 5 files you must touch

| # | File                                                                  | What to add                                                                  |
| - | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1 | `apps/web/src/lib/oauth-providers.ts`                                 | Entry in `OAUTH_PROVIDERS` (URLs, scopes, PKCE/auth/body modes, accountInfo) |
| 2 | `apps/web/src/lib/connector-catalog.ts`                               | Entry in `CONNECTOR_CATALOG` (slug, label, `authType: 'oauth2'`, hint, `credentialType`) |
| 3 | `apps/web/src/lib/connector-help.ts`                                  | Entry in `OAUTH_GUIDES` (step-by-step setup with redirect URI prompt)        |
| 4 | `apps/web/src/app/(dashboard)/credentials/CredentialWizard.tsx`       | Entry in `PROVIDER_CONFIGS` + entry in `TYPE_OPTIONS`                        |
| 5 | `packages/db/src/schema/credentials.ts` + new migration               | Extend `credentials_type_check` constraint to include the new type            |

Optional 6th if the provider returns identity inside the token response (Notion-style instead of a dedicated userinfo endpoint):

| 6 | `apps/web/src/app/api/oauth/[provider]/callback/route.ts` | Add a type guard + branch in the accountName resolver |

## Provider research — what to find before you touch a single file

Open the provider's OAuth docs and write these values down:

1. **Authorization endpoint** (where you redirect the user)
2. **Token endpoint** (where you POST the code)
3. **Required scopes** for the features you actually use (don't ask for more than needed — providers often gate broader scopes behind app review)
4. **PKCE support**: required, optional, or unsupported. Default to PKCE S256 if available — it's strictly better than client_secret-only.
5. **Token endpoint auth method**: `Authorization: Basic base64(id:secret)` header, or `client_id` + `client_secret` in the body? Many providers accept both, some reject one.
6. **Token endpoint body format**: `application/x-www-form-urlencoded` or `application/json`? Almost always form for OAuth 2.0; Notion is an outlier with JSON.
7. **Refresh token**: does the provider issue a `refresh_token`? If yes, how (always vs `access_type=offline` flag vs `prompt=consent`)?
8. **Account info endpoint**: an HTTP GET that returns `{name, email, …}` given the access token, used to label the credential. Or — for some providers — the identity is already in the token response (Notion's `workspace_name` is the canonical case).
9. **Redirect URI rules**: HTTPS-only? Localhost exception? Raw IPs forbidden? Wildcard support? Exact match required (almost always yes).
10. **Verification status**: do the scopes you need require Google verification / Slack distribution / etc.? If yes, expect 1–6 weeks of process and a different test workflow.

Keep that note next to you while editing the files.

## File-by-file detail

### 1. `apps/web/src/lib/oauth-providers.ts`

Add an entry keyed by your catalog slug. Example shape (look at `airtable-oauth` for a real one):

```ts
'slack-oauth': {
  slug: 'slack-oauth',
  label: 'Slack',
  authUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  scopes: ['chat:write', 'channels:read', 'users:read'],
  pkce: 'none',                 // or 'pkce-s256'
  tokenAuth: 'body',            // or 'basic'
  tokenBodyType: 'form',        // or 'json'
  accountInfo: {
    url: 'https://slack.com/api/users.identity',
    nameField: 'user.name',
    emailField: 'user.email',  // optional
  },
  supportsRefresh: true,
  authExtraParams: { user_scope: '' },  // any provider-specific extras
  credentialType: 'slack-oauth',
}
```

Also extend the `getProviderByCredentialType` helper if it has explicit cases (currently it iterates the registry, so usually no edit needed).

### 2. `apps/web/src/lib/connector-catalog.ts`

```ts
{
  slug: 'slack-oauth',
  label: 'Slack',
  authType: 'oauth2',
  docsHint: 'OAuth flow for a Slack workspace integration.',
  credentialType: 'slack-oauth',
}
```

The `slug` here MUST match the key you used in `OAUTH_PROVIDERS`. The route `/api/oauth/slack-oauth/start` and `/api/oauth/slack-oauth/callback` derive their behaviour from this slug + the registry.

### 3. `apps/web/src/lib/connector-help.ts`

Add an entry in `OAUTH_GUIDES` keyed by `credentialType`. Match the existing tone (concise, action-oriented, English). Walk the user through:

1. Where to go on the provider's site to register an OAuth app.
2. Required app type / category (e.g. Public vs Internal for Notion).
3. **Mandatory: a dedicated step "Add this redirect URI"** with the hint `Most common cause of failure when trying to connect.` — Quentin lost a full evening on Airtable because that step was buried in a sub-clause.
4. Required scopes — list each one, and emphasise saving the change so the provider persists it (we've seen Airtable silently keep scopes unsaved).
5. Where to find the Client ID / Client secret on the integration detail page.
6. Format hint: `Client ID is a UUID. Secret starts with secret_` etc. — helps users notice if they paste the wrong field.

If the provider has a non-trivial constraint (e.g. Airtable's no-LAN-IP rule), add a `warning` field. Use `warningWhen: 'lan-ip-only'` if the warning only applies when the dashboard is accessed via a raw LAN IP — the wizard hides it on localhost so the message isn't misleading there.

### 4. `apps/web/src/app/(dashboard)/credentials/CredentialWizard.tsx`

Two small additions:

```ts
// PROVIDER_CONFIGS map
'slack-oauth': {
  label: 'Slack',
  callbackPath: '/api/oauth/slack-oauth/callback',
  namePlaceholder: 'Mon Slack',
  clientIdLabel: 'Client ID',
  clientSecretLabel: 'Client secret',
  // instructions field is gone — guides come from connector-help.ts now
},

// TYPE_OPTIONS array (controls the wizard's step-1 radio cards)
{ type: 'slack-oauth', label: 'Slack', description: 'OAuth integration' },
```

Update the `CredentialWizardType` union accordingly:

```ts
export type CredentialWizardType = 'google-oauth' | 'notion-oauth' | 'airtable-oauth' | 'slack-oauth';
```

### 5. DB constraint update

The credentials table has a check constraint:

```ts
check('credentials_type_check',
  sql`${table.type} IN ('google-oauth','notion-oauth','airtable-oauth')`),
```

Edit `packages/db/src/schema/credentials.ts` to extend the IN list, then run drizzle-kit:

```powershell
$env:DATABASE_URL='postgresql://nodalai:nodalai@localhost:25433/nodalai'; pnpm --filter @nodalai/db db:generate
```

Inspect the generated SQL — it should DROP and re-ADD the check constraint with the new IN list. Apply:

```powershell
$env:DATABASE_URL='postgresql://nodalai:nodalai@localhost:25433/nodalai'; pnpm --filter @nodalai/db db:migrate
```

Update `packages/db/src/tests/helpers.ts` to mirror the new check in the test DB DDL.

Also update the `CREDENTIAL_TYPES` const in `packages/shared/src/entities/credential.ts` and the related Zod payload schema if the new provider has a meaningfully different shape (most don't — they reuse `GoogleOauthPayloadSchema`).

### 6. (Optional) Identity in the token response

Some providers don't have a dedicated userinfo endpoint. Notion is the canonical example: its token response already includes `bot.owner.user.name` and `workspace_name`, so we extract identity right there.

If your new provider works that way:

1. Set `accountInfo: null` in the registry.
2. Edit `apps/web/src/app/api/oauth/[provider]/callback/route.ts`. Find the `isNotionResponse` type guard and add a sibling guard for your provider. Then in the account-name resolver block, add a branch that pulls the right field.

Example skeleton:

```ts
function isLinearResponse(r: TokenResponse): r is LinearTokenResponse {
  return 'team_id' in r && 'team_name' in r;
}
// …
} else if (isLinearResponse(tokenResponse)) {
  accountName = tokenResponse.team_name ?? null;
}
```

Define the `TokenResponse` union to include the new shape.

## Common gotchas

- **Redirect URI mismatch (most common reason credential creation fails)**: the URI sent during the auth request must EXACTLY match what's registered on the provider. Even one trailing slash, port mismatch, or `localhost` vs `127.0.0.1` will be rejected.
- **Scopes registered on the provider but not saved**: many provider dashboards have a "Save changes" step after toggling scopes. If you forget it, the OAuth flow fails with `invalid_scope` even though the UI shows them ticked.
- **Wrong app type**: Notion has Public vs Internal integrations — only Public does OAuth. Slack has classic vs Granular bot tokens. Airtable has Personal Access Tokens (no OAuth) vs OAuth integrations. Pick the right one or the credentials won't work.
- **Sensitive scopes require app verification**: Google's `https://www.googleapis.com/auth/gmail.send` is a famous example. While unverified, the app works for the developer + listed test users only. Production rollout needs Google's verification process (1–6 weeks, requires security audit for some scopes).
- **HTTPS-only redirect URI**: some providers refuse anything but HTTPS. For dev, run `ngrok http 3000` or `cloudflared tunnel` and register the public URL.
- **Raw LAN IPs rejected**: Airtable refuses `192.168.x.x` style URIs. Use `localhost` for the OAuth flow (the resulting credential works from any host afterwards). If your new provider has a similar rule, add `warningWhen: 'lan-ip-only'` in the help guide.

## Testing

After the 5 file edits + DB migration, you should have these passing:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm deps:check
```

Then a Playwright e2e — copy one of the existing specs (`oauth-flow.spec.ts` for Google, `airtable-oauth.spec.ts` for Airtable) into `apps/web/tests/e2e/<provider>-oauth.spec.ts` and adapt:

- The slug in the connector card click target.
- The mock provider URL pattern in `context.route()`.
- The mock token response (access_token, refresh_token, expires_in, scope, account info shape).
- The expected accountName in the connected card assertion.

The dev server must be running on port 3000 — Playwright doesn't auto-start it. Use the `code.startsWith('mock-')` bypass in `callback/route.ts` to short-circuit the real token-endpoint call during e2e (already implemented for all providers; works generically because the bypass is keyed on the code prefix, not provider).

## Manual smoke test (5 minutes)

After the e2e spec passes:

1. Open `/credentials` → there should be no credential of the new type yet.
2. Open `/connectors` → the new card appears with status `disconnected`.
3. Click Connect → wizard opens with the new type pre-selected.
4. Verify the help guide is the one you wrote.
5. Verify the redirect URI displayed matches `${origin}/api/oauth/<your-slug>/callback`.
6. Register the OAuth app on the provider (real one, not mocked) with that redirect URI.
7. Paste real client ID/secret, click Continue → consent page → callback → toast "X connected".
8. Card shows `connected` + the right accountName.
9. Click Refresh now (if `supportsRefresh: true`) → toast "Token refreshed".
10. Disconnect → card returns to `disconnected`.

If all 10 work, ship it.

## Out of scope of this doc

- **OAuth 1.0a** providers (legacy Twitter v1, Trello, Tumblr): different flow signature. The current registry assumes OAuth 2.0. To support 1.0a you'd need a parallel code path — not impossible but treat as its own brique.
- **Device authorization flow** (used by Apple TV style apps with no browser): also out of scope today.
- **Single sign-on (SAML / OIDC ID tokens)** for dashboard sign-in: NodalAI uses better-auth for that, separate from connector OAuth.
