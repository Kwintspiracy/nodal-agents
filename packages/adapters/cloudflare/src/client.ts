// @nodal-agents/adapter-cloudflare — account context over the OFFICIAL
// `cloudflare` SDK (invariant #7). One context per connector instance:
// resolves (once, cached) the account id + workers.dev subdomain the API
// token gives access to, so the user only ever pastes ONE value (the token)
// in the connectors UI — no separate "Account ID" field to hunt for.

import Cloudflare from 'cloudflare';
import { CloudflareApiError, mapCloudflareHttpError } from './errors.ts';

export type ResolvedAccount = { accountId: string; subdomain: string };

/** Wrap any SDK/network failure into the adapter's typed error. */
export function wrapCloudflareError(err: unknown): CloudflareApiError {
  if (err instanceof CloudflareApiError) return err;
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') return mapCloudflareHttpError(status, message);
  return new CloudflareApiError('cloudflare_unknown', message);
}

export class CloudflareAccountContext {
  readonly apiToken: string;
  readonly client: Cloudflare;
  private resolved: ResolvedAccount | null = null;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    this.client = new Cloudflare({ apiToken });
  }

  /**
   * Resolve the account id + workers.dev subdomain for this token. Fails loud
   * (never guesses) on: zero accounts (token unscoped/invalid), multiple
   * accounts (ambiguous — the token must be scoped to ONE account), and a
   * never-registered workers.dev subdomain (first-time accounts must enable
   * it once in the dashboard).
   */
  async resolve(): Promise<ResolvedAccount> {
    if (this.resolved) return this.resolved;
    let accounts: Array<{ id: string; name?: string }>;
    try {
      const page = await this.client.accounts.list();
      accounts = page.result.map((a) => ({ id: a.id, name: a.name }));
    } catch (err) {
      throw wrapCloudflareError(err);
    }
    if (accounts.length === 0) {
      throw new CloudflareApiError(
        'cloudflare_no_account',
        'The API token gives access to no Cloudflare account. Create the token from the ' +
          '"Edit Cloudflare Workers" template, scoped to your account.',
      );
    }
    if (accounts.length > 1) {
      throw new CloudflareApiError(
        'cloudflare_multiple_accounts',
        `The API token spans ${String(accounts.length)} Cloudflare accounts — ambiguous. ` +
          'Re-create it scoped to exactly ONE account (token settings → Account Resources).',
      );
    }
    const accountId = accounts[0]!.id;

    let subdomain: string;
    try {
      const res = await this.client.workers.subdomains.get({ account_id: accountId });
      subdomain = res.subdomain;
    } catch (err) {
      const wrapped = wrapCloudflareError(err);
      if (wrapped.code === 'cloudflare_not_found') {
        throw new CloudflareApiError(
          'cloudflare_subdomain_missing',
          'This account has no workers.dev subdomain yet. Enable it once in the Cloudflare ' +
            'dashboard (Workers & Pages → your subdomain), then retry.',
        );
      }
      throw wrapped;
    }
    if (!subdomain) {
      throw new CloudflareApiError(
        'cloudflare_subdomain_missing',
        'This account has no workers.dev subdomain yet. Enable it once in the Cloudflare ' +
          'dashboard (Workers & Pages → your subdomain), then retry.',
      );
    }

    this.resolved = { accountId, subdomain };
    return this.resolved;
  }
}
