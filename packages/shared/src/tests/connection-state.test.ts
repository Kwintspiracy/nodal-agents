// connection-state.test.ts — one vocabulary and one classification for every
// connection, by protocol: no provider is named by the rules, and the same
// answers hold for any of them.

import { describe, it, expect } from 'vitest';
import {
  ConnectionUnavailableError,
  NOT_CHECKED,
  attemptDue,
  callFailure,
  connectionNoteForModel,
  connectionState,
  connectorConnection,
  httpFailure,
  isOffered,
  networkFailure,
  tokenEndpointFailure,
  worstConnection,
} from '../connection-state';
import { connectorAccess, connectionOfAccess, offeredOperations } from '../oauth/scopes';
import type { OperationDescriptor } from '../types/operation';

const now = new Date('2026-11-28T12:00:00Z');

describe('a token endpoint’s answer (RFC 6749 §5.2), the same for every provider', () => {
  for (const code of ['invalid_grant', 'invalid_client', 'unauthorized_client']) {
    it(`${code} means the grant no longer stands: needs_reauth, with the provider’s words`, () => {
      const s = tokenEndpointFailure(
        400,
        JSON.stringify({ error: code, error_description: 'gone' }),
        now,
      );
      expect(s).toMatchObject({
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: `400 ${code} gone`,
      });
      expect(attemptDue(s, now)).toBe(false);
    });
  }
  it('a 5xx is the provider being unavailable: unreachable, retried after a minute', () => {
    const s = tokenEndpointFailure(503, 'Service Unavailable', now);
    expect(s).toMatchObject({ state: 'unreachable', cause: 'provider_unavailable' });
    expect(s.retryAfter!.getTime() - now.getTime()).toBe(60_000);
    expect(attemptDue(s, now)).toBe(false);
    expect(attemptDue(s, new Date(now.getTime() + 60_001))).toBe(true);
  });
});

describe('a provider API’s answer', () => {
  it('401 refuses the token; 5xx is unreachable; 403, 404, 429 say nothing about the connection', () => {
    expect(httpFailure(401, 'Unauthorized', now)?.state).toBe('needs_reauth');
    expect(httpFailure(502, 'Bad Gateway', now)?.state).toBe('unreachable');
    for (const status of [400, 403, 404, 409, 429])
      expect(httpFailure(status, 'x', now)).toBeNull();
  });
  it('an adapter error keeps the status it carries, whatever the adapter', () => {
    const anyAdapter = Object.assign(new Error('Request had invalid authentication credentials.'), {
      code: 'some_unauthorized',
      status: 401,
    });
    expect(callFailure(anyAdapter, now)).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
  });
  it('a transport failure is unreachable, read from the system code or from the wrapped message', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
    });
    expect(networkFailure(wrapped, now)).toMatchObject({ state: 'unreachable', cause: 'network' });
    expect(
      networkFailure(new Error('request failed, reason: connect ECONNREFUSED 1.2.3.4:443'), now)
        ?.cause,
    ).toBe('network');
    expect(networkFailure(new DOMException('aborted', 'TimeoutError'), now)?.cause).toBe('timeout');
    // An adapter that re-wraps Node's fetch keeps only its fixed message.
    expect(networkFailure(new Error('fetch failed'), now)?.cause).toBe('network');
    expect(networkFailure(new Error('Record not found'), now)).toBeNull();
  });
  it('a classified connection error passes through unchanged', () => {
    const s = connectionState('broken', 'undecryptable', null, now);
    expect(
      callFailure(new ConnectionUnavailableError({ kind: 'credential', id: 'c' }, s), now),
    ).toBe(s);
  });
});

describe('the state of a connector, from its rows', () => {
  const refused = connectionState('needs_reauth', 'grant_refused', '400 invalid_grant', now);
  const down = connectionState(
    'unreachable',
    'network',
    'ECONNREFUSED',
    now,
    new Date(now.getTime() + 60_000),
  );
  it('no credential or key: needs_reauth, said as removed or missing', () => {
    expect(
      connectorConnection({ secretKind: 'credential', secret: 'absent', stored: [] }).cause,
    ).toBe('credential_removed');
    expect(connectorConnection({ secretKind: 'api_key', secret: 'absent', stored: [] }).cause).toBe(
      'key_missing',
    );
  });
  it('a secret that cannot be read is broken, whatever was stored', () => {
    expect(
      connectorConnection({
        secretKind: 'credential',
        secret: 'unreadable',
        stored: [NOT_CHECKED],
      }),
    ).toMatchObject({ state: 'broken', cause: 'undecryptable' });
  });
  it('several rows: the most severe wins; nothing observed is working, not checked', () => {
    expect(
      connectorConnection({
        secretKind: 'credential',
        secret: 'readable',
        stored: [down, refused],
      }),
    ).toBe(refused);
    expect(
      connectorConnection({ secretKind: 'credential', secret: 'readable', stored: [NOT_CHECKED] }),
    ).toEqual(NOT_CHECKED);
    expect(worstConnection()).toEqual(NOT_CHECKED);
  });
});

describe('the access decision takes the state in, as more kinds of the same union', () => {
  const ops: OperationDescriptor[] = [
    { slug: 'read', name: 'Read', risk: 'read', requiresApproval: false, scopes: [['scope.read']] },
    {
      slug: 'write',
      name: 'Write',
      risk: 'write',
      requiresApproval: false,
      scopes: [['scope.write']],
    },
  ];
  it('needs_reauth and broken offer nothing; unreachable keeps the grant’s verdict', () => {
    const refused = connectionState('needs_reauth', 'grant_refused', null, now);
    const access = connectorAccess(ops, ['scope.read', 'scope.write'], undefined, refused);
    expect(access).toEqual({ kind: 'needs_reauth', connection: refused });
    expect(offeredOperations(access)).toEqual([]);
    expect(isOffered(refused)).toBe(false);

    const down = connectionState('unreachable', 'timeout', null, now, now);
    const partial = connectorAccess(ops, ['scope.read'], undefined, down);
    expect(partial).toMatchObject({
      kind: 'unreachable',
      grantedOperations: ['read'],
      missingOperations: ['write'],
    });
    expect(offeredOperations(partial)).toEqual(['read']);
  });
  it('a missing right is needs_reauth in the shared vocabulary, its scopes as the detail', () => {
    const access = connectorAccess(ops, ['scope.read']);
    expect(connectionOfAccess(access)).toMatchObject({
      state: 'needs_reauth',
      cause: 'rights_missing',
      detail: 'scope.write',
    });
  });
});

describe('what the model reads', () => {
  it('names the service and the account, the reason, and where the person repairs it', () => {
    const note = connectionNoteForModel(
      { label: 'Work mail', account: 'me@work.example', kind: 'connector' },
      connectionState('needs_reauth', 'grant_refused', '400 invalid_grant', now),
    );
    expect(note).toBe(
      'Work mail (account "me@work.example") is attached but disconnected: the provider refused its ' +
        'authorisation (provider said: 400 invalid_grant). No call to it can succeed until the person ' +
        'repairs it from the Connectors page (Reconnect); tell them so instead of trying another way.',
    );
  });
  it('an MCP server and a channel are sent to their own pages', () => {
    const broken = connectionState('broken', 'command_not_found', 'spawn x ENOENT', now);
    expect(connectionNoteForModel({ label: 'My db', kind: 'mcp_server' }, broken)).toContain(
      'the MCP servers page',
    );
    expect(connectionNoteForModel({ label: 'Telegram', kind: 'channel' }, broken)).toContain(
      "the agent's Channels tab",
    );
  });
  it('a cause never pairs with another state', () => {
    expect(() => connectionState('working', 'grant_refused', null)).toThrow(/does not belong/);
  });
});
