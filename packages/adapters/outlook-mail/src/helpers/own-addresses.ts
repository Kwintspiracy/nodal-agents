// @nodal-agents/adapter-outlook-mail — the addresses this mailbox sends as
//
// A reply needs to know which participants are the mailbox owner: a reply to
// one's own message goes to its recipients, and reply-to-all removes oneself
// (mail contract, @nodal-agents/shared/mail-contract). Graph's `/me` would
// need User.Read, which this connector does not ask for; the OpenID Connect
// userinfo endpoint Graph hosts is covered by the `openid` and `email` scopes
// it already asks for, and is the endpoint the connection itself reads its
// account from. `email` is null on some personal accounts, so
// `preferred_username` (always present, an address) is read too.

import type { Client } from '@microsoft/microsoft-graph-client';
import { OutlookAdapterError } from '../errors';

interface UserInfo {
  email?: string | null;
  preferred_username?: string | null;
}

export async function listOwnAddresses(client: Client): Promise<string[]> {
  const info = (await client.api('https://graph.microsoft.com/oidc/userinfo').get()) as UserInfo;
  const addresses = [info.email, info.preferred_username].filter(
    (a): a is string => typeof a === 'string' && a.includes('@'),
  );
  if (addresses.length === 0) {
    // Without them a reply cannot tell the owner's own messages apart, and
    // could address the owner instead of the other party: fail loud.
    throw new OutlookAdapterError(
      'outlook_unknown',
      "Microsoft returned no address for this mailbox: the reply's recipients cannot be resolved.",
    );
  }
  return addresses;
}
