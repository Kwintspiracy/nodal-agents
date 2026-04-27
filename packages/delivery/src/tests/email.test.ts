// email.test.ts — sendEmail placeholder: asserts not-configured error

import { describe, it, expect } from 'vitest';
import { sendEmail } from '../channels/email.ts';
import { DeliveryError } from '../errors.ts';

describe('sendEmail (placeholder)', () => {
  it('throws DeliveryError with code delivery_email_not_configured', async () => {
    await expect(
      sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        body: 'Hello',
        from: 'no-reply@example.com',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'delivery_email_not_configured';
    });
  });

  it('throws even when all options are valid strings', async () => {
    await expect(
      sendEmail({ to: 'a@b.com', subject: 'S', body: 'B', from: 'f@b.com' }),
    ).rejects.toBeInstanceOf(DeliveryError);
  });
});
