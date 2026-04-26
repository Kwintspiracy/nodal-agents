import { describe, it, expect } from 'vitest';
import { BearerTokenProvider } from '../providers/bearer-token.ts';
import { LOCAL_USER_ID, LOCAL_ENTITY_ID } from '../providers/local-trust.ts';
import { fakeRequest } from './helpers.ts';

const TOKEN = 'my-secret-lan-token';

describe('BearerTokenProvider', () => {
  it('returns local session for a valid token', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(session).toEqual({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  });

  it('returns null for an invalid token', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: 'Bearer wrong-token' } }),
    );
    expect(session).toBeNull();
  });

  it('returns null when Authorization header is missing', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(fakeRequest({}));
    expect(session).toBeNull();
  });

  it('returns null when Authorization header has wrong scheme', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: `Basic ${TOKEN}` } }),
    );
    expect(session).toBeNull();
  });

  it('returns null when token is empty string even if header is present', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: 'Bearer ' } }),
    );
    // "Bearer " splits to ["Bearer", ""], second part is "" which !== TOKEN
    expect(session).toBeNull();
  });

  it('is case-insensitive on the Bearer scheme keyword', async () => {
    const provider = new BearerTokenProvider({ token: TOKEN });
    const session = await provider.getSession(
      fakeRequest({ headers: { Authorization: `BEARER ${TOKEN}` } }),
    );
    expect(session).toEqual({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  });
});
