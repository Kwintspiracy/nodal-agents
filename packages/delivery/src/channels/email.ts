// channels/email.ts — placeholder; throws delivery_email_not_configured until a provider is wired in

import { DeliveryError } from '../errors.ts';

export interface EmailSendOpts {
  to: string;
  subject: string;
  body: string;
  from: string;
}

export async function sendEmail(_opts: EmailSendOpts): Promise<{ id: string }> {
  throw new DeliveryError('delivery_email_not_configured');
}
