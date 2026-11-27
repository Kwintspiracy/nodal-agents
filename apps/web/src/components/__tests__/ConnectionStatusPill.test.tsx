// ConnectionStatusPill.test.tsx — the pill a person reads for each state of a
// connection, with the reason in words, on every screen that shows one
// (connectors, credentials, MCP servers, channels).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionState } from '@nodal-agents/shared';
import ConnectionStatusPill from '../ConnectionStatusPill.tsx';

function render(connection: ConnectionState): { text: string; html: string } {
  const html = renderToStaticMarkup(<ConnectionStatusPill connection={connection} withReason />);
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

const at = new Date('2026-11-28T10:00:00Z');
const state = (
  s: ConnectionState['state'],
  cause: ConnectionState['cause'],
  extra: Partial<ConnectionState> = {},
): ConnectionState => ({
  state: s,
  cause,
  detail: null,
  observedAt: at,
  retryAfter: null,
  ...extra,
});

describe('the status pill of a connection, one per state @cap:connecter-un-service/ecran', () => {
  it('working, never checked: Connected, and no reason invented', () => {
    const { text } = render({ ...state('working', 'not_checked'), observedAt: null });
    expect(text).toBe('Connected');
  });

  it('working after a call: Connected, with when it last worked', () => {
    expect(render(state('working', 'succeeded')).text).toMatch(/^Connected Last worked /);
  });

  it('a grant the provider ended: Reconnect, the reason and the provider’s own words', () => {
    const { text, html } = render(
      state('needs_reauth', 'grant_refused', {
        detail: '400 invalid_grant Token has been expired or revoked.',
      }),
    );
    expect(text).toContain('Reconnect');
    expect(text).toContain(
      'The provider no longer accepts this authorisation. Reconnect to authorise again.',
    );
    expect(text).toContain(
      'The provider said: 400 invalid_grant Token has been expired or revoked.',
    );
    expect(html).toContain('bg-warn-bg');
  });

  it('a missing right: Needs access, the scopes named', () => {
    const { text } = render(
      state('needs_reauth', 'rights_missing', {
        detail: 'https://www.googleapis.com/auth/gmail.send',
      }),
    );
    expect(text).toContain('Needs access');
    expect(text).toContain('Missing: https://www.googleapis.com/auth/gmail.send');
  });

  it('a deleted credential: Reconnect, said as such', () => {
    expect(render(state('needs_reauth', 'credential_removed')).text).toContain(
      'Its credential was deleted.',
    );
  });

  it('an unreachable provider: Unreachable, with when Nodal tries again', () => {
    const { text, html } = render(
      state('unreachable', 'network', {
        detail: 'connect ECONNREFUSED',
        retryAfter: new Date('2026-11-28T10:01:00Z'),
      }),
    );
    expect(text).toContain('Unreachable');
    expect(text).toContain('Nodal tries again after');
    expect(text).toContain('The provider said: connect ECONNREFUSED');
    expect(html).not.toContain('bg-ok-bg');
  });

  it('a secret this installation cannot read: Broken', () => {
    const { text } = render(state('broken', 'undecryptable'));
    expect(text).toContain('Broken');
    expect(text).toContain('cannot be read by this installation');
  });

  it('a server whose command does not start: Broken, with the system’s words', () => {
    const { text } = render(
      state('broken', 'command_not_found', { detail: 'spawn npx-missing ENOENT' }),
    );
    expect(text).toContain('Broken');
    expect(text).toContain(
      'Its command could not be started on this machine. The system said: spawn npx-missing ENOENT',
    );
  });
});
