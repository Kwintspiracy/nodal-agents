// local-auth owner-claim tests.
//
// The claim flow exists for ONE scenario: an install born in local-trust
// (seeded user, real workspace, no password) that switches to local-auth.
// Sign-up is closed (a user exists) and sign-in has no valid password — the
// login page would be a dead end. claimOwnerAccount attaches an email +
// credential to the existing user, and MUST produce a hash that better-auth's
// own /api/auth/sign-in/email endpoint verifies — that round-trip is the
// critical assertion here, not any call count.

import { describe, it, expect, beforeAll } from 'vitest';
import { verifyPassword } from 'better-auth/crypto';
import { eq } from '@nodal-agents/db';
import {
  createLocalAuthProvider,
  ClaimError,
  type LocalAuthProvider,
} from '../providers/local-auth.ts';
import { seedLocalUser, LOCAL_USER_ID } from '../providers/local-trust.ts';
import { spinUpAuthTestDb, schema } from './helpers.ts';
import type { AuthTestDb } from './helpers.ts';

const SECRET = 'test-secret-that-is-long-enough-32ch';
const BASE = 'http://localhost:3000';

let db: AuthTestDb;
let provider: LocalAuthProvider;

function makeProvider(overDb: AuthTestDb) {
  return createLocalAuthProvider({ db: overDb, baseURL: BASE, secret: SECRET });
}

beforeAll(async () => {
  db = (await spinUpAuthTestDb()).db;
  provider = makeProvider(db);
});

describe('getSetupState', () => {
  it("'fresh' on an empty database — regular first-user sign-up applies", async () => {
    expect(await provider.getSetupState()).toBe('fresh');
  });

  it("'claim' once the local-trust seed exists without any account", async () => {
    await seedLocalUser(db);
    expect(await provider.getSetupState()).toBe('claim');
  });
});

describe('claimOwnerAccount', () => {
  it('rejects a short password without writing any row', async () => {
    await expect(
      provider.claimOwnerAccount({ email: 'quentin@example.com', password: 'short' }),
    ).rejects.toThrow(ClaimError);
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(0);
  });

  it('rejects a malformed email without writing any row', async () => {
    await expect(
      provider.claimOwnerAccount({ email: 'not-an-email', password: 'long-enough-pass' }),
    ).rejects.toThrow(ClaimError);
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(0);
  });

  it('attaches email + credential to the EXISTING user — same id, workspace intact', async () => {
    const { userId } = await provider.claimOwnerAccount({
      email: 'Quentin@Example.com',
      password: 'correct horse battery',
    });
    // The seeded user was claimed — not a new one created.
    expect(userId).toBe(LOCAL_USER_ID);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, LOCAL_USER_ID));
    expect(user!.email).toBe('quentin@example.com');
    expect(user!.emailVerified).toBe(true);
    expect(user!.name).toBe('quentin');

    const accountRows = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, LOCAL_USER_ID));
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]!.providerId).toBe('credential');
    expect(
      await verifyPassword({ hash: accountRows[0]!.password!, password: 'correct horse battery' }),
    ).toBe(true);
  });

  it("state is 'ready' after the claim", async () => {
    expect(await provider.getSetupState()).toBe('ready');
  });

  it('the claimed credential signs in through the REAL better-auth endpoint', async () => {
    const res = await provider.handleAuthRequest(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ email: 'quentin@example.com', password: 'correct horse battery' }),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('set-cookie')).toContain('better-auth');
  });

  it('a second claim is refused: claim_closed', async () => {
    await expect(
      provider.claimOwnerAccount({ email: 'intrus@example.com', password: 'whatever-else-1' }),
    ).rejects.toMatchObject({ code: 'claim_closed' });
    // The refused claim must not have altered the owner.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, LOCAL_USER_ID));
    expect(user!.email).toBe('quentin@example.com');
  });
});

describe('claimOwnerAccount — ambiguous install', () => {
  it('refuses when several users exist without any account, and writes nothing', async () => {
    const freshDb = (await spinUpAuthTestDb()).db;
    const freshProvider = makeProvider(freshDb);
    await seedLocalUser(freshDb);
    await freshDb.insert(schema.users).values({ email: 'deuxieme@example.com' });

    await expect(
      freshProvider.claimOwnerAccount({ email: 'qui@example.com', password: 'long-enough-pass' }),
    ).rejects.toMatchObject({ code: 'claim_ambiguous' });
    const rows = await freshDb.select().from(schema.accounts);
    expect(rows).toHaveLength(0);
  });
});
