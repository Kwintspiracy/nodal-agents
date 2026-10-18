// claim-owner-schema.test.ts — the owner-claim form is one-shot and the only
// way in on a migrated install: a realistic address refused here locks the
// first owner out. Pins the verdict of the real schema (the only `.email()` of
// the repo) on realistic and on clearly invalid addresses, so a zod upgrade
// that changes its email pattern turns this red instead of the login page.
import { describe, it, expect } from 'vitest';
import { ClaimOwnerSchema } from '../claim-owner-schema';

const PASSWORD = 'correct horse battery';

const verdict = (email: string) => ClaimOwnerSchema.safeParse({ email, password: PASSWORD });

describe('ClaimOwnerSchema email @cap:se-connecter/moteur', () => {
  it.each([
    'quentin@example.com',
    'first.last@example.com',
    'user+tag@example.com',
    'USER@EXAMPLE.COM',
    'Mixed.Case@Example.Org',
    '12345@example.com',
    'a@b.co',
    'user@sub.domain.example.com',
    'user@my-domain.com',
    'user@example.photography',
    "o'brien@example.com",
    'under_score@example.com',
    'user@xn--bcher-kva.example',
    '  padded@example.com  ',
  ])('accepts %s', (email) => {
    const r = verdict(email);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe(email.trim());
  });

  it.each([
    '',
    'plainaddress',
    '@example.com',
    'user@',
    'user@@example.com',
    'user@example',
    'user example@example.com',
    'user@exa mple.com',
    '.user@example.com',
    'user..name@example.com',
    'user@-example.com',
    `${'a'.repeat(190)}@example.com`,
  ])('rejects %j', (email) => {
    expect(verdict(email).success).toBe(false);
  });

  // Not a regression: refused identically by zod 4.4.3 and 4.6.7 (checked by
  // running this file against both). A user with a non-ASCII address must enter
  // the punycode form (`user@xn--bcher-kva.example`, accepted above). Pinned so
  // that a change of this verdict, either way, is seen.
  it.each(['user@bücher.example', 'üser@example.com', 'user@例え.jp'])(
    'refuses the non-ASCII address %s (unchanged since 4.4.3)',
    (email) => {
      expect(verdict(email).success).toBe(false);
    },
  );

  it('reports the failing field for an invalid address', () => {
    const r = verdict('nope');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['email']);
  });
});
