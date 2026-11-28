// @nodal-agents/adapter-gmail — the addresses this mailbox sends as
//
// A reply needs to know which participants are the mailbox owner: a reply to
// one's own message goes to its recipients, and reply-to-all removes oneself
// (mail contract, @nodal-agents/shared/mail-contract). Gmail's
// `users.settings.sendAs.list` "includes the primary send-as address
// associated with the account as well as any custom 'from' aliases", and is
// granted by the gmail.readonly scope the connector already asks for.

import type { gmail_v1 } from 'googleapis';
import { GmailAdapterError } from '../errors';

export async function listOwnAddresses(gmail: gmail_v1.Gmail): Promise<string[]> {
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const addresses = (res.data.sendAs ?? [])
    .map((s) => s.sendAsEmail ?? '')
    .filter((a) => a.length > 0);
  if (addresses.length === 0) {
    // Without them a reply cannot tell the owner's own messages apart, and
    // could address the owner instead of the other party: fail loud.
    throw new GmailAdapterError(
      'gmail_unknown',
      "Gmail returned no send-as address for this mailbox: the reply's recipients cannot be resolved.",
    );
  }
  return addresses;
}
