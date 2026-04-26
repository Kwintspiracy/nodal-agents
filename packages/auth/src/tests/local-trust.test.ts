import { describe, it, expect, beforeAll } from 'vitest';
import {
  LocalTrustProvider,
  seedLocalUser,
  LOCAL_USER_ID,
  LOCAL_ENTITY_ID,
} from '../providers/local-trust.ts';
import { spinUpAuthTestDb, fakeRequest, schema } from './helpers.ts';
import type { AuthTestDb } from './helpers.ts';
import { eq } from '@nodalai/db';

let db: AuthTestDb;

beforeAll(async () => {
  const result = await spinUpAuthTestDb();
  db = result.db;
});

describe('LocalTrustProvider', () => {
  it('always returns the local session regardless of request', async () => {
    const provider = new LocalTrustProvider();
    const session = await provider.getSession(fakeRequest({}));
    expect(session).toEqual({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  });

  it('returns the local session even for requests with auth headers', async () => {
    const provider = new LocalTrustProvider();
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: 'Bearer wrong-token' } }),
    );
    expect(session).toEqual({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  });

  it('local user ID and entity ID are stable constants', () => {
    expect(LOCAL_USER_ID).toBe('00000000-0000-0000-0000-000000000001');
    expect(LOCAL_ENTITY_ID).toBe('00000000-0000-0000-0000-000000000002');
  });
});

describe('seedLocalUser', () => {
  it('inserts local user and entity on first call', async () => {
    await seedLocalUser(db);

    const users = await db.select().from(schema.users).where(eq(schema.users.id, LOCAL_USER_ID));
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe('local@nodalai.local');

    const entities = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, LOCAL_ENTITY_ID));
    expect(entities).toHaveLength(1);
    expect(entities[0]?.slug).toBe('local');
  });

  it('creates entity_member with owner role', async () => {
    await seedLocalUser(db);

    const members = await db
      .select()
      .from(schema.entityMembers)
      .where(eq(schema.entityMembers.userId, LOCAL_USER_ID));
    expect(members.length).toBeGreaterThanOrEqual(1);
    expect(members[0]?.role).toBe('owner');
  });

  it('is idempotent — calling twice does not create duplicate rows', async () => {
    await seedLocalUser(db);
    await seedLocalUser(db); // second call should be a no-op

    const users = await db.select().from(schema.users).where(eq(schema.users.id, LOCAL_USER_ID));
    expect(users).toHaveLength(1);

    const entities = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, LOCAL_ENTITY_ID));
    expect(entities).toHaveLength(1);

    const members = await db
      .select()
      .from(schema.entityMembers)
      .where(eq(schema.entityMembers.userId, LOCAL_USER_ID));
    expect(members).toHaveLength(1);
  });

  it('returns the fixed user and entity IDs', async () => {
    const result = await seedLocalUser(db);
    expect(result.userId).toBe(LOCAL_USER_ID);
    expect(result.entityId).toBe(LOCAL_ENTITY_ID);
  });
});
