// connection-status.ts — the words a person reads about a connection's state.
//
// The state comes from the engine (`connection_states`, combined by
// `connectorConnection` / `connectorAccessFor`): this module only says it. One
// label per state and one reason per cause, for every kind of source (a
// connector, a credential, an MCP server, a channel), so every screen says the
// same thing the agent's context and the tool's error say.

import type { ConnectionState, ConnectionStateKind } from '@nodal-agents/shared';
import type { StatusVariant } from '@/components/ui/StatusPill';

const LABEL: Record<ConnectionStateKind, string> = {
  working: 'Connected',
  needs_reauth: 'Reconnect',
  unreachable: 'Unreachable',
  broken: 'Broken',
};

const VARIANT: Record<ConnectionStateKind, StatusVariant> = {
  working: 'done',
  needs_reauth: 'warn',
  unreachable: 'idle',
  broken: 'warn',
};

/** Revived from JSON (a server action's result crosses as plain data). */
function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export function connectionLabel(c: ConnectionState): string {
  if (c.state === 'needs_reauth' && c.cause === 'rights_missing') return 'Needs access';
  return LABEL[c.state];
}

export function connectionVariant(c: ConnectionState): StatusVariant {
  return VARIANT[c.state];
}

function when(value: Date | string | null): string {
  const d = asDate(value);
  return d ? d.toLocaleString() : '';
}

/**
 * Why, in one or two short sentences, with the provider's own words quoted
 * when it gave some. Null when there is nothing to say (working, never
 * checked).
 */
export function connectionReason(c: ConnectionState): string | null {
  const said = c.detail ? ` The provider said: ${c.detail}` : '';
  switch (c.cause) {
    case 'not_checked':
      return null;
    case 'authorised':
    case 'succeeded':
      return c.observedAt ? `Last worked ${when(c.observedAt)}.` : null;
    case 'grant_refused':
      return `The provider no longer accepts this authorisation. Reconnect to authorise again.${said}`;
    case 'rights_missing':
      return `The authorisation lacks rights this connector needs. Use Add access to ask for them.${
        c.detail ? ` Missing: ${c.detail}` : ''
      }`;
    case 'credential_removed':
      return 'Its credential was deleted. Reconnect to give it one.';
    case 'key_missing':
      return 'It has no key. Add one to use it.';
    case 'rotation_lost':
      return `A new token from the provider could not be saved, so this authorisation no longer works. Reconnect to authorise again.${said}`;
    case 'no_refresh':
      return 'Its access expired and the provider gives no way to renew it. Reconnect to authorise again.';
    case 'network':
    case 'timeout':
    case 'provider_unavailable':
      return `The provider could not be reached${
        c.retryAfter ? `. Nodal tries again after ${when(c.retryAfter)}` : ''
      }.${said}`;
    case 'undecryptable':
      return 'Its stored secret cannot be read by this installation (the master key changed). Connect it again.';
    case 'command_not_found':
      return `Its command could not be started on this machine.${
        c.detail ? ` The system said: ${c.detail}` : ''
      }`;
    case 'config_incomplete':
      return 'Its configuration is incomplete. Edit it to finish the setup.';
  }
}
